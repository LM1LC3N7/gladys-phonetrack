// -----------------------------------------------------------------------------
// PhonetrackApp: the integration. One PhoneTrack session, read through its
// public token. Read only.
//
//   start(config)  (re)connects: the last positions read, Discovery
//                  published, the loop started
//   loop           every `poll_interval` s (60 by default):
//                  GET api/getlastpositions/<token> -> position, battery,
//                  accuracy, speed, altitude, bearing, satellites, last seen,
//                  silent; the trigger `device_silent` (once per silence and
//                  threshold, never for what was already silent at start)
//   failures       a refused token (401 / 403, or PhoneTrack's 404 "Session
//                  not found") stops for 1 h, then 6 h, then 24 h, kept in
//                  /data: never a loop, Nextcloud counts every refusal as a
//                  brute-force attempt; HTTP 429 and 5xx pause every request
//                  (bounded, kept in /data); anything else is retried, never
//                  faster than the poll interval, doubling up to 30 min
//
// No position, device name, token or URL is ever logged or written to /data.
// The loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch (still in flight when Nextcloud failed) never schedules itself
// again.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  FEATURES,
  INTERVALS,
  LIMITS,
  SCENE_TRIGGERS,
  SILENT_MINUTES,
  STORE_FILE,
} from './constants.js';
import { buildDevice, createdDevices, deviceIds, deviceKey, sessionKey } from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { PhonetrackClient } from './phonetrack/client.js';
import { CODES, PhonetrackError, isRefused } from './phonetrack/errors.js';
import { httpRequest } from './phonetrack/http.js';
import { formatDate } from './phonetrack/parse.js';

/** The "Test the connection" button waits 60 s: answer before. */
const TEST_BUDGET_MS = 55_000;
/** A point this far in the future (clock of Gladys late) is not a baseline. */
const FUTURE_MS = 5 * 60_000;
/** Wall clock and monotonic clock apart by more than this: the clock jumped. */
const CLOCK_JUMP_MS = 5 * 60_000;
/** The configuration could not be read from Gladys: try again after this. */
const CONFIG_RETRY_MS = 60_000;
const MINUTE = 60_000;
/** Entries per publishTransports call (the SDK refuses more). */
export const TRANSPORTS_PER_CALL = 100;
const THRESHOLDS = SILENT_MINUTES.map(Number);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** The value of a state entry, number or text, as one comparable key. */
const valueOf = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);

export class PhonetrackApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake PhoneTrack)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now] the wall clock (ms)
   * @param {() => number} [options.monotonic] a clock that never jumps (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'phonetrack' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now: monotonic });
    /** Both clocks at the last reading (a jump of the wall clock is a new baseline). */
    this.lastClock = null;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    this.lastStatus = null;
    /** The /data key of the server: a salted digest of its address (set by run()). */
    this.baseKey = null;
    /**
     * In memory only, kept across a restart of the app for the same server
     * and session (a reconnection to Gladys), forgotten for another one:
     *   known      the devices last read (Discovery during a pause)
     *   silence    key -> Set of the thresholds (minutes) already reached in
     *              the current silence of the device (fired, or reached
     *              before the device was first seen: never fired then)
     *   satellites the keys of the devices whose logger sent satellites
     */
    this.memoryKey = null;
    this.known = null;
    this.silence = new Map();
    this.satellites = new Set();
    /**
     * After a failed reading: { key (HMAC of address and token), at, delay,
     * message }, so that a reconnection to Gladys does not skip the wait.
     */
    this.retryWait = null;
    /** Values last accepted by Gladys (feature -> value), to budget only changes. */
    this.published = new Map();
    /** Where the next cut of each group of states starts (they take turns). */
    this.cursors = new Map();
    /** The reading in flight: one at a time (loop, Discovery). */
    this.reading = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.refusalStep = 0;
    this.retryDelay = this.minRetry();
    /** key -> device, the followed devices of the last reading. */
    this.devices = new Map();
    /** Devices above the cap of LIMITS.DEVICES. */
    this.capped = 0;
    this.silentCount = 0;
    this.discoveredKey = null;
    this.transports = new Map();
    this.published.clear();
  }

  /** A failure is never read again faster than the poll interval. */
  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, (this.config?.pollSeconds ?? 60) * 1000);
  }

  pollMs() {
    return this.config.pollSeconds * 1000;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * saved the configuration: one attempt at once, even within the stop that
   * follows a refusal (a new refusal moves to the next, longer step).
   * `immediate`: read now even within the retry wait of a failure (the test
   * button); neither lifts a pause asked by Nextcloud.
   */
  start(rawConfig, { force = false, immediate = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force, immediate }));
  }

  /** The values a refusal is about (HMAC with the salt of /data: never the token). */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([config.server.base, config.token]))
      .digest('hex');
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  /**
   * The refusal kept for this server: { key, step, until, pending, forced }
   * or null. `pending`: an attempt was in flight (counted as a refusal if
   * the app stopped before its answer); `forced`: the one attempt a saved
   * configuration may make in this series of refusals was used.
   */
  storedRefusal(baseKey) {
    const raw = baseKey ? this.store.get('refusals', baseKey) : null;
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (typeof value?.k !== 'string' || !value.k) return null;
      return {
        key: value.k,
        step: Math.max(1, Math.floor(Number(value.s)) || 1),
        until: Number(value.u) || 0,
        pending: value.p === true,
        forced: value.f === true,
      };
    } catch {
      return null;
    }
  }

  async writeRefusal(baseKey, refusal) {
    const value = refusal
      ? JSON.stringify({
          k: refusal.key,
          s: refusal.step,
          u: refusal.until,
          p: refusal.pending === true,
          f: refusal.forced === true,
        })
      : null;
    await this.store.set('refusals', baseKey, value);
  }

  /** The stop after the n-th refusal in a row: 1 h, 6 h, then 24 h. */
  stepDelay(step) {
    const steps = INTERVALS.REFUSAL_STEPS_MS;
    return steps[Math.min(Math.max(1, step), steps.length) - 1];
  }

  /**
   * Start from the configuration kept by Gladys (at every connection). If it
   * cannot be read, the last one the SDK received is used; without any, the
   * status says so and a timer tries again: never without status nor timer.
   */
  async startFromGladys() {
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Configuration not read from Gladys: ${err.message}`);
      const kept = this.gladys.config;
      if (kept && typeof kept === 'object' && Object.keys(kept).length > 0) {
        config = kept;
      } else {
        await this.enqueue(async () => {
          this.halt();
          await this.setStatus(false, T.status.configUnreadable);
          this.schedule(CONFIG_RETRY_MS, () => this.startFromGladys());
        });
        return;
      }
    }
    await this.start(config);
  }

  async run(rawConfig, { force = false, immediate = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    // The core keeps the status and Discovery in memory: a start (a
    // reconnection to Gladys included) always sends them again.
    this.lastStatus = null;
    await this.store.load();

    if (config.tokenUnsupported) {
      await this.stopWith(T.status.tokenUnsupported);
      return;
    }
    if (config.urlError) {
      const message = {
        missing: T.status.urlMissing,
        http: T.status.urlHttp,
        credentials: T.status.urlCredentials,
        link: T.status.urlLink,
        mismatch: T.status.urlMismatch,
      }[config.urlError];
      await this.stopWith(message ?? T.status.urlInvalid);
      return;
    }
    if (config.tokenInvalid) {
      await this.stopWith(T.status.tokenInvalid);
      return;
    }
    if (!config.token) {
      await this.stopWith(T.status.missingToken);
      return;
    }
    if (config.fingerprintInvalid) {
      await this.stopWith(T.status.fingerprintInvalid);
      return;
    }
    const memoryKey = JSON.stringify([config.server.base, sessionKey(config.token)]);
    if (memoryKey !== this.memoryKey) {
      this.memoryKey = memoryKey;
      this.known = null;
      this.silence = new Map();
      this.satellites = new Set();
      this.retryWait = null;
    }
    this.client = new PhonetrackClient({
      server: config.server,
      token: config.token,
      fingerprint: config.fingerprint,
      request: this.request,
    });
    // Never the address: the token is part of the URL.
    this.logger.info('Reading the configured PhoneTrack session');

    // /data never holds the address: its entries are keyed by a salted digest.
    this.baseKey = createHmac('sha256', await this.store.salt())
      .update(`server:${config.server.base}`)
      .digest('hex')
      .slice(0, 32);
    // A refusal of these very values: wait for the end of its stop (1 h,
    // 6 h, 24 h). Saving the configuration makes one attempt per series of
    // refusals; another token or address is tried at once.
    const base = this.baseKey;
    let refusal = this.storedRefusal(base);
    const key = await this.refusalKey(config);
    if (refusal && refusal.key !== key) {
      await this.writeRefusal(base, null);
      refusal = null;
    }
    if (refusal) {
      if (refusal.pending) {
        // An attempt was in flight when the app stopped: its answer is
        // unknown, so it counts as one more refusal (never a loop).
        const step = refusal.step + 1;
        refusal = { ...refusal, step, until: this.now() + this.stepDelay(step), pending: false };
        await this.writeRefusal(base, refusal);
      }
      this.refusalStep = refusal.step;
      // The end read back is capped by the delay of its own step.
      const until = Math.min(refusal.until, this.now() + this.stepDelay(refusal.step));
      if (until < refusal.until) {
        refusal = { ...refusal, until };
        await this.writeRefusal(base, refusal);
      }
      if (this.now() < until) {
        if (force && !refusal.forced) {
          await this.writeRefusal(base, { ...refusal, forced: true });
        } else {
          this.blocked = true;
          await this.publishKnown();
          const message =
            force && refusal.forced
              ? T.status.alreadyRetried(until - this.now())
              : T.status.stillRefused(until - this.now(), refusal.forced);
          await this.setStatus(false, message);
          this.schedule(until - this.now(), () => this.retryAfterRefusal(generation));
          return;
        }
      }
    }
    // A pause (HTTP 429 or 5xx) outlives a restart, a reconnection to Gladys
    // and a saved configuration; its end is capped (a clock jump, a file
    // written by hand) and the capped end is written back.
    const stored = Number(this.store.get('meta', this.pauseKey())) || 0;
    const pausedUntil = Math.min(stored, this.now() + INTERVALS.BUSY_MAX_MS);
    if (pausedUntil < stored) await this.store.set('meta', this.pauseKey(), String(pausedUntil));
    if (this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.publishKnown();
      await this.setStatus(false, T.status.paused(delay));
      this.schedule(delay, () => this.connect(generation));
      return;
    }
    // After a failed reading, a reconnection to Gladys waits for the retry
    // like the loop would (never faster than the interval); the button and
    // a saved configuration read at once.
    const waiting = this.retryWait;
    if (!force && !immediate && waiting?.key === key) {
      if (this.now() < waiting.at) {
        this.retryDelay = waiting.delay;
        await this.publishKnown();
        await this.setStatus(false, waiting.message);
        this.schedule(waiting.at - this.now(), () => this.connect(generation));
        return;
      }
      this.retryDelay = waiting.delay;
    }
    await this.connect(generation);
  }

  /** The stop after a refusal is over: one attempt (a new refusal goes one step further). */
  async retryAfterRefusal(generation) {
    if (generation !== this.generation) return;
    this.blocked = false;
    await this.connect(generation);
  }

  /** Discovery from the devices last read, and the badges (during a stop). */
  async publishKnown() {
    if (this.known) {
      for (const device of this.known.devices) this.devices.set(device.key, device);
      await this.publishDiscovered();
    }
    await this.publishTransports();
  }

  pauseKey() {
    return `pausedUntil|${this.baseKey}`;
  }

  /** Stopped before any request (configuration): status and badges. */
  async stopWith(message) {
    await this.publishTransports();
    await this.setStatus(false, message);
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** Schedule the next reading of the current epoch. */
  scheduleLoop(delay, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => this.loop(generation, epoch));
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** The first reading, then the loop. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    try {
      await this.refresh({ publish: true });
      if (generation !== this.generation) return;
      this.logger.info(`PhoneTrack answers: ${this.devices.size} device(s) followed`);
    } catch (err) {
      await this.failed(err, generation);
      return;
    }
    this.scheduleLoop(this.pollMs(), generation);
  }

  async loop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    if (this.reading) {
      // A Discovery reading is in flight: it is this round's.
      await this.reading.catch(() => {});
      if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
      return;
    }
    try {
      await this.refresh({ publish: false });
    } catch (err) {
      // What Nextcloud answered is kept in /data even when this loop is no
      // longer the current one; only the rescheduling is skipped then.
      if (this.current(generation, epoch)) await this.failed(err, generation);
      else await this.persistFailure(err);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
  }

  /**
   * Write what a failed reading means to /data, whatever the generation (a
   * refusal or a 429 answered while Gladys disconnected, or while a new
   * configuration started, is never lost). Uses the context captured when
   * the request was sent (server key, HMAC, step). Returns the plan:
   * { kind: 'refused' | 'stepWait' | 'pause' | 'retry', step?, delay? }.
   */
  async persistFailure(err) {
    const ctx = err?.context ?? {
      baseKey: this.baseKey,
      key: null,
      step: this.refusalStep,
      pollMs: this.pollMs(),
    };
    if (!ctx.baseKey || !this.config.server) return { kind: 'retry' };
    const key = ctx.key ?? (await this.refusalKey(this.config));
    const stored = this.storedRefusal(ctx.baseKey);
    const forced = stored?.key === key ? stored.forced : false;
    const now = this.now();
    if (isRefused(err)) {
      // 1 h, 6 h, then 24 h for every refusal after: never a loop.
      const step = ctx.step + 1;
      const delay = this.stepDelay(step);
      await this.writeRefusal(ctx.baseKey, { key, step, until: now + delay, forced });
      return { kind: 'refused', step, delay };
    }
    let pause = null;
    if (err?.status === 429) {
      // Too many requests: a bounded pause of every path.
      pause = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        Math.max(INTERVALS.BUSY_MIN_MS, ctx.pollMs),
        INTERVALS.BUSY_MAX_MS,
      );
    } else if (err?.status >= 500) {
      pause = clamp(err.retryAfterMs ?? this.retryDelay, this.retryDelay, INTERVALS.BUSY_MAX_MS);
    }
    if (pause !== null) {
      await this.store.set('meta', `pausedUntil|${ctx.baseKey}`, String(now + pause));
    }
    if (ctx.step > 0) {
      // Within a series of refusals, no failure (a timeout...) is ever
      // retried before the end of the current step.
      const delay = Math.max(this.stepDelay(ctx.step), pause ?? 0);
      await this.writeRefusal(ctx.baseKey, {
        key,
        step: ctx.step,
        until: now + delay,
        forced,
      });
      return { kind: 'stepWait', step: ctx.step, delay };
    }
    return pause !== null ? { kind: 'pause', delay: pause } : { kind: 'retry' };
  }

  /** A reading failed: a long stop on a refusal, a pause, or a retry with a growing delay. */
  async failed(err, generation) {
    const plan = await this.persistFailure(err);
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (plan.kind === 'refused' || plan.kind === 'stepWait') {
      this.refusalStep = plan.step;
      this.blocked = true;
      if (plan.kind === 'refused') {
        this.logger.warn(
          `Token refused by Nextcloud (HTTP ${err.status}, refusal ${plan.step} in a row): next attempt in ${Math.round(plan.delay / MINUTE)} min`,
        );
      } else {
        this.logger.warn(`PhoneTrack fails after a refusal: ${this.describe(err)}`);
      }
      const message =
        plan.kind === 'refused'
          ? T.status.refused(err.status, plan.delay)
          : this.errorMessage(err, plan.delay);
      await this.setStatus(false, message);
      this.schedule(plan.delay, () => this.retryAfterRefusal(generation));
      return;
    }
    let delay = this.retryDelay;
    const pause = plan.kind === 'pause';
    if (pause) {
      delay = plan.delay;
      this.pausedUntil = this.now() + delay;
    }
    if (err?.status !== 429)
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    if (!(err instanceof PhonetrackError)) {
      this.logger.error(`Internal error of the integration: ${this.describe(err)}`);
    } else if (wasOnline || delay === this.minRetry() || pause) {
      this.logger.warn(`PhoneTrack fails: ${this.describe(err)}`);
    }
    const message = this.errorMessage(err, delay);
    this.retryWait = {
      key: await this.refusalKey(this.config),
      at: this.now() + delay,
      delay: this.retryDelay,
      message,
    };
    if (generation !== this.generation) return;
    await this.setStatus(false, message);
    this.schedule(delay, () => this.connect(generation));
  }

  /** A failure in a few words for the logs: never a URL (src/phonetrack/http.js). */
  describe(err) {
    return `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;
  }

  errorMessage(err, delay) {
    // A fault of the integration itself is never shown as a fault of Nextcloud.
    if (!(err instanceof PhonetrackError)) return T.status.internal(delay);
    if (err.code === CODES.TOO_LARGE) return T.status.tooLarge(delay);
    if (err.code === CODES.TLS_UNTRUSTED) return T.status.tlsUntrusted(delay);
    if (err.code === CODES.TLS_CHANGED) return T.status.tlsChanged(delay);
    if (err.status === 429) return T.status.busy(delay);
    if (err.status >= 500) return T.status.serverError(err.status, delay);
    if (err.code === CODES.BAD_ANSWER || err.code === CODES.HTTP) {
      return T.status.notPhonetrack(delay);
    }
    return T.status.unreachable(err, delay);
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading -----------------------------------------------------------------

  /** Read the last positions and publish them. Throws when they cannot be read. */
  refresh(options) {
    const reading = this.read(options).finally(() => {
      if (this.reading === reading) this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  async read({ publish }) {
    const client = this.client;
    if (!client) return;
    // The context of this request, kept with its failure: what is written to
    // /data never depends on what the app became in between.
    const context = {
      baseKey: this.baseKey,
      key: await this.refusalKey(this.config),
      step: this.refusalStep,
      pollMs: this.pollMs(),
    };
    if (context.step > 0) {
      // An attempt after a refusal: if the app stops before the answer, the
      // next start counts it as a refusal.
      const stored = this.storedRefusal(context.baseKey);
      await this.writeRefusal(context.baseKey, {
        key: context.key,
        step: context.step,
        until: stored?.key === context.key ? stored.until : this.now(),
        pending: true,
        forced: stored?.key === context.key ? stored.forced : false,
      });
    }
    let all;
    try {
      all = await client.lastPositions();
    } catch (err) {
      if (err && typeof err === 'object') err.context = context;
      throw err;
    }
    // The share works: forget a refusal and a pause asked earlier (even if
    // the app moved on meanwhile: the answer is true for these values).
    if (this.storedRefusal(context.baseKey)?.key === context.key) {
      await this.writeRefusal(context.baseKey, null);
    }
    if (this.store.get('meta', `pausedUntil|${context.baseKey}`)) {
      await this.store.set('meta', `pausedUntil|${context.baseKey}`, null);
    }
    if (client !== this.client) return;
    this.refusalStep = 0;
    this.pausedUntil = 0;

    const token = this.config.token;
    const createdKeys = new Set(createdDevices(this.gladys).map((c) => c.key));
    const withKeys = all.map((device) => ({ ...device, key: deviceKey(token, device.name) }));
    // The cap keeps the devices created in Gladys first, then the others by name.
    const followed = [
      ...withKeys.filter((d) => createdKeys.has(d.key)),
      ...withKeys.filter((d) => !createdKeys.has(d.key)),
    ]
      .slice(0, LIMITS.DEVICES)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((device) => {
        if (device.satellites !== null) this.satellites.add(device.key);
        return { ...device, hasSatellites: this.satellites.has(device.key) };
      });
    const now = this.now();
    // A jump of the wall clock between two readings (NTP after a start with
    // a wrong clock): this reading is a new baseline, no event.
    const mono = this.monotonic();
    const jumped =
      this.lastClock !== null &&
      Math.abs(now - this.lastClock.wall - (mono - this.lastClock.mono)) > CLOCK_JUMP_MS;
    if (jumped) this.logger.info('The clock jumped: no silence event at this reading');
    this.lastClock = { wall: now, mono };
    const silentMs = this.config.silentMinutes * MINUTE;
    /** [device, minutes, reached]: thresholds to fire (marked reached once sent). */
    const candidates = [];
    let silentCount = 0;
    for (const device of followed) {
      try {
        const age = device.timestampMs === null ? null : Math.max(0, now - device.timestampMs);
        device.age = age;
        device.silent = age === null ? null : age >= silentMs;
        if (device.silent) silentCount += 1;
        if (age === null) continue;
        // A point far in the future (the clock of Gladys late at start): no
        // baseline from it.
        if (device.timestampMs - now > FUTURE_MS) continue;
        // A device seen for the first time: what is already reached is never
        // fired (no event at the first reading, nor for a new device).
        const first = jumped || !this.silence.has(device.key);
        const reached = this.silence.get(device.key) ?? new Set();
        this.silence.set(device.key, reached);
        if (age < THRESHOLDS[0] * MINUTE) {
          // A newer point: the silence is over.
          reached.clear();
          continue;
        }
        for (const minutes of THRESHOLDS) {
          if (age < minutes * MINUTE || reached.has(minutes)) continue;
          // Only the devices created in Gladys fire; the others only record.
          if (first || !createdKeys.has(device.key)) reached.add(minutes);
          else candidates.push([device, minutes, reached]);
        }
      } catch (err) {
        this.logger.debug(`A device was skipped: ${this.describe(err)}`);
      }
    }
    this.devices = new Map(followed.map((device) => [device.key, device]));
    this.capped = all.length - followed.length;
    this.silentCount = silentCount;
    this.online = true;
    this.retryDelay = this.minRetry();
    this.retryWait = null;
    this.known = { devices: followed };

    const discoveredKey = JSON.stringify(followed.map((d) => [d.key, d.name, d.hasSatellites]));
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishStates();
    await this.publishTransports();
    // A threshold is marked reached only once its event left; beyond 30,
    // the rest waits for the next reading.
    for (const [device, minutes, reached] of candidates.slice(0, LIMITS.EVENTS_PER_ROUND)) {
      if (await this.fire(device, minutes)) reached.add(minutes);
    }
    if (candidates.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.info(
        `${candidates.length - LIMITS.EVENTS_PER_ROUND} silence event(s) left for the next reading`,
      );
    }
    await this.setStatus(true, this.okMessage());
  }

  okMessage() {
    if (this.devices.size === 0) return T.status.noDevice;
    return T.status.ok({
      total: this.devices.size + this.capped,
      silent: this.silentCount,
      silentMinutes: this.config.silentMinutes,
      capped: this.capped,
    });
  }

  /** Resolves true when the event left, false otherwise (never throws). */
  async fire(device, minutes) {
    return this.gladys
      .publishSceneEvent(SCENE_TRIGGERS.DEVICE_SILENT, {
        device: deviceIds(this.gladys, device.key).device,
        minutes: String(minutes),
        device_name: device.name.slice(0, LIMITS.NAME_LENGTH),
        silent_for: Math.floor(device.age / MINUTE),
        last_seen: formatDate(device.timestampMs) ?? '',
      })
      .then(
        () => true,
        (err) => {
          this.logger.warn(`Scene event not sent: ${err.message}`);
          return false;
        },
      );
  }

  /** Never throws: a refusal of Gladys is not a PhoneTrack failure. */
  async publishDiscovered() {
    const devices = [...this.devices.values()].map((device) => buildDevice(this.gladys, device));
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.reading) {
      // A reading is in flight: no second request, publish what it brings.
      await this.reading.catch(() => {});
      await this.publishDiscovered();
      return;
    }
    if (this.online && !this.paused() && this.client) {
      const generation = this.generation;
      const done = await this.refresh({ publish: true }).then(
        () => true,
        async (err) => {
          // Any failure takes the usual path (refusal, pause, retry); an
          // older generation only keeps what Nextcloud answered.
          if (generation !== this.generation) {
            await this.persistFailure(err);
            return true;
          }
          await this.failed(err, generation);
          return false;
        },
      );
      if (done) return;
    }
    if (this.devices.size === 0 && this.known) {
      for (const device of this.known.devices) this.devices.set(device.key, device);
    }
    await this.publishDiscovered();
  }

  /**
   * The states of the created devices, by priority: silent, the position
   * (latitude and longitude always together), the battery, the other
   * numbers, the last seen text. Only the features of the created device get
   * a state (a feature it lacks, satellites added later, waits for "Update").
   * A created device missing from the reading gets nothing.
   */
  statesOf() {
    const groups = { silent: [], position: [], battery: [], numbers: [], texts: [] };
    for (const created of this.gladys.devices ?? []) {
      const device = this.devices.get(this.keyOf(created));
      if (!device) continue;
      const ids = deviceIds(this.gladys, device.key);
      const has = new Set((created.features ?? []).map((f) => f?.external_id));
      const state = (key, value) =>
        value === null || value === undefined || !has.has(ids.feature(key))
          ? null
          : { device_feature_external_id: ids.feature(key), state: value };
      const bundle = (...states) => states.filter(Boolean);
      groups.silent.push(
        bundle(state(FEATURES.SILENT, device.silent === null ? null : +device.silent)),
      );
      const lat = state(FEATURES.LATITUDE, device.lat);
      const lon = state(FEATURES.LONGITUDE, device.lon);
      if (lat && lon) groups.position.push([lat, lon]);
      groups.battery.push(bundle(state(FEATURES.BATTERY, device.battery)));
      for (const [key, value] of [
        [FEATURES.ACCURACY, device.accuracy],
        [FEATURES.SPEED, device.speedKmh],
        [FEATURES.ALTITUDE, device.altitude],
        [FEATURES.BEARING, device.bearing],
        [FEATURES.SATELLITES, device.satellites],
      ]) {
        groups.numbers.push(bundle(state(key, value)));
      }
      const lastSeen = formatDate(device.timestampMs);
      if (lastSeen && has.has(ids.feature(FEATURES.LAST_SEEN))) {
        groups.texts.push([
          { device_feature_external_id: ids.feature(FEATURES.LAST_SEEN), text: lastSeen },
        ]);
      }
    }
    return groups;
  }

  keyOf(created) {
    const prefix = this.gladys.externalId('device:');
    const id = created?.external_id;
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const key = id.slice(prefix.length);
    return key.includes(':') ? null : key;
  }

  /**
   * Publish what changed, every state within the minute budget (POST /state
   * admits 300 per minute; this integration stays under 250), group by group
   * in priority order. A bundle (latitude with longitude) is never split;
   * when a group is cut, its bundles take turns. What is held back goes at a
   * later reading.
   */
  async publishStates() {
    const changed = (bundle) =>
      bundle.filter((s) => this.published.get(s.device_feature_external_id) !== valueOf(s));
    let room = this.budget.remaining();
    const list = [];
    let held = 0;
    for (const [name, bundles] of Object.entries(this.statesOf())) {
      const fresh = bundles.map(changed).filter((b) => b.length > 0);
      const size = fresh.reduce((sum, b) => sum + b.length, 0);
      if (size <= room) {
        for (const b of fresh) list.push(...b);
        room -= size;
        continue;
      }
      const start = fresh.length > 0 ? (this.cursors.get(name) ?? 0) % fresh.length : 0;
      let taken = 0;
      for (let i = 0; i < fresh.length; i += 1) {
        const b = fresh[(start + i) % fresh.length];
        if (b.length > room) break;
        list.push(...b);
        room -= b.length;
        taken += 1;
      }
      this.cursors.set(name, start + taken);
      held += fresh.slice(taken).reduce((sum, b) => sum + b.length, 0);
    }
    if (held > 0) this.logger.debug(`${held} state(s) held back (state budget)`);
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
      for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
    } catch (err) {
      // Gladys may have counted them anyway: the budget does too.
      this.budget.record(list.length);
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  /** Forget what was published for a device (Gladys forgot it too). */
  forget(externalId) {
    if (typeof externalId !== 'string') return;
    const prefix = `${externalId}:`;
    for (const id of [...this.published.keys()]) {
      if (id === externalId || id.startsWith(prefix)) this.published.delete(id);
    }
  }

  async publishTransports() {
    const entries = createdDevices(this.gladys).map(({ key, externalId }) => ({
      external_id: externalId,
      transport: this.online && this.devices.has(key) ? 'cloud' : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  /** Created or updated: the SDK forgot the values of this device, so do we. */
  async deviceCreated(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
    if (this.online) await this.publishStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
  }

  /** Read only: nothing is ever sent to PhoneTrack. */
  async setValue() {
    throw new Error(T.errors.readOnly);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * Reconnects, then reports, within 50 s. Never shortens the stop after a
   * refusal (only saving the configuration does) nor a pause.
   */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig, { immediate: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({ total: this.devices.size + this.capped, silent: this.silentCount });
  }
}
