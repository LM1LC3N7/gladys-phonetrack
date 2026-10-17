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
import { CODES, isRefused } from './phonetrack/errors.js';
import { httpRequest } from './phonetrack/http.js';
import { formatDate } from './phonetrack/parse.js';

/** The "Test the connection" button waits 60 s: answer before. */
const TEST_BUDGET_MS = 50_000;
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
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'phonetrack' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now });
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

  /** The refusal kept for this server: { key, step, until } or null. */
  storedRefusal(base) {
    const raw = this.store.get('refusals', base);
    if (!raw) return null;
    const [key, step, until] = raw.split('|');
    const parsed = { key, step: Number(step) || 1, until: Number(until) || 0 };
    return key ? parsed : null;
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
    // 6 h, 24 h), unless the configuration was just saved (one attempt).
    const base = this.baseKey;
    const refusal = this.storedRefusal(base);
    const key = await this.refusalKey(config);
    if (refusal && refusal.key !== key) {
      await this.store.set('refusals', base, null);
    } else if (refusal) {
      this.refusalStep = refusal.step;
      const cap = this.now() + INTERVALS.REFUSAL_STEPS_MS.at(-1);
      const until = Math.min(refusal.until, cap);
      if (until < refusal.until) {
        await this.store.set('refusals', base, `${refusal.key}|${refusal.step}|${until}`);
      }
      if (!force && this.now() < until) {
        this.blocked = true;
        await this.publishKnown();
        await this.setStatus(false, T.status.stillRefused(until - this.now()));
        this.schedule(until - this.now(), () => this.retryAfterRefusal(generation));
        return;
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
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
  }

  /** A reading failed: a long stop on a refusal, a pause, or a retry with a growing delay. */
  async failed(err, generation) {
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (isRefused(err)) {
      // 1 h, 6 h, then 24 h for every refusal after: never a loop.
      const steps = INTERVALS.REFUSAL_STEPS_MS;
      this.refusalStep += 1;
      const delay = steps[Math.min(this.refusalStep, steps.length) - 1];
      const until = this.now() + delay;
      this.blocked = true;
      await this.store.set(
        'refusals',
        this.baseKey,
        `${await this.refusalKey(this.config)}|${this.refusalStep}|${until}`,
      );
      this.logger.warn(
        `Token refused by Nextcloud (HTTP ${err.status}, refusal ${this.refusalStep} in a row): next attempt in ${Math.round(delay / 60_000)} min`,
      );
      if (generation !== this.generation) return;
      await this.setStatus(false, T.status.refused(err.status, delay));
      this.schedule(delay, () => this.retryAfterRefusal(generation));
      return;
    }
    let delay = this.retryDelay;
    let pause = false;
    if (err.status === 429) {
      // Too many requests: a bounded pause of every path.
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        Math.max(INTERVALS.BUSY_MIN_MS, this.pollMs()),
        INTERVALS.BUSY_MAX_MS,
      );
      pause = true;
    } else {
      if (err.status >= 500) {
        delay = clamp(err.retryAfterMs ?? delay, delay, INTERVALS.BUSY_MAX_MS);
        pause = true;
      }
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    }
    if (pause) {
      this.pausedUntil = this.now() + delay;
      await this.store.set('meta', this.pauseKey(), String(this.pausedUntil));
    }
    if (wasOnline || delay === this.minRetry() || pause) {
      // err.message never holds the URL (src/phonetrack/http.js).
      this.logger.warn(`PhoneTrack fails: ${err.message}`);
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

  errorMessage(err, delay) {
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
    const all = await client.lastPositions();
    if (client !== this.client) return;
    // The share works: forget a refusal and a pause asked earlier.
    const base = this.baseKey;
    if (this.store.get('refusals', base)) await this.store.set('refusals', base, null);
    if (this.store.get('meta', this.pauseKey())) {
      await this.store.set('meta', this.pauseKey(), null);
    }
    this.refusalStep = 0;
    this.pausedUntil = 0;

    const token = this.config.token;
    const followed = all.slice(0, LIMITS.DEVICES).map((device) => {
      const key = deviceKey(token, device.name);
      if (device.satellites !== null) this.satellites.add(key);
      return { ...device, key, hasSatellites: this.satellites.has(key) };
    });
    const now = this.now();
    const silentMs = this.config.silentMinutes * 60_000;
    const events = [];
    let silentCount = 0;
    for (const device of followed) {
      const age = device.timestampMs === null ? null : Math.max(0, now - device.timestampMs);
      device.age = age;
      device.silent = age === null ? null : age >= silentMs;
      if (device.silent) silentCount += 1;
      if (age === null) continue;
      // A device seen for the first time: what is already reached is never
      // fired (no event at the first reading, nor for a new device).
      const first = !this.silence.has(device.key);
      const reached = this.silence.get(device.key) ?? new Set();
      this.silence.set(device.key, reached);
      for (const minutes of THRESHOLDS) {
        if (age >= minutes * 60_000) {
          if (!reached.has(minutes)) {
            reached.add(minutes);
            if (!first) events.push([device, minutes]);
          }
        } else {
          // A newer point: the silence of this threshold is over.
          reached.delete(minutes);
        }
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
    for (const [device, minutes] of events.slice(0, LIMITS.EVENTS_PER_ROUND)) {
      await this.fire(device, minutes);
    }
    if (events.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.warn(`${events.length - LIMITS.EVENTS_PER_ROUND} silence event(s) not sent`);
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

  async fire(device, minutes) {
    await this.gladys
      .publishSceneEvent(SCENE_TRIGGERS.DEVICE_SILENT, {
        device: deviceIds(this.gladys, device.key).device,
        minutes: String(minutes),
        device_name: device.name.slice(0, LIMITS.NAME_LENGTH),
        silent_for: Math.floor(device.age / 60_000),
        last_seen: formatDate(device.timestampMs) ?? '',
      })
      .catch((err) => {
        this.logger.warn(`Scene event not sent: ${err.message}`);
      });
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
          if (generation !== this.generation) return true;
          // Any failure takes the usual path (refusal, pause, retry).
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
