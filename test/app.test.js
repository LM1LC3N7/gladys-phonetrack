// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake PhoneTrack,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PhonetrackApp } from '../src/app.js';
import { ACTIONS, INTERVALS, LIMITS, SCENE_TRIGGERS } from '../src/constants.js';
import { buildDevice, deviceKey } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { TOKEN, createFakePhonetrack, point } from './helpers/fakePhonetrack.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');
const MIN = 60_000;
const HOUR = 3600_000;
const SELECTOR = 'phonetrack';
const ids = createFakeGladys({ selector: SELECTOR });
const URL_ = 'https://cloud.example.org';
const BASE_CONFIG = { url: URL_, token: TOKEN };
const WRONG = 'ffffffffffffffffffffffffffffffff';
const key = (name) => deviceKey(TOKEN, name);
const device = (name, options = {}) => buildDevice(ids, { key: key(name), name, ...options });
const featureId = (name, feature) => `ext:${SELECTOR}:device:${key(name)}:${feature}`;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({
  config = {},
  created = [device('Alice'), device('Bob', { hasSatellites: true })],
  phonetrack,
  dataDir,
  now = T0,
} = {}) {
  const clock = { now, jump: 0 };
  phonetrack ??= createFakePhonetrack();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'pt-app-'));
  const app = new PhonetrackApp({
    gladys,
    logger,
    request: phonetrack.request,
    dataDir,
    now: () => clock.now,
    // The monotonic clock follows the test clock unless a test makes the
    // wall clock jump (clock.jump).
    monotonic: () => clock.now - clock.jump,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, phonetrack, timers, clock, logs, app, dataDir };
}

const poll = (timers, ms = 60_000) => timers.run((delay) => delay === ms);
const last = (gladys, name, feature) => gladys.fake.lastState(featureId(name, feature));
const storeText = (dataDir) =>
  readdirSync(dataDir)
    .map((file) => readFileSync(join(dataDir, file), 'utf8'))
    .join('\n');
/** Emit `connected` again (Gladys came back) and wait for the restart. */
async function reconnect(gladys, app) {
  gladys.emit('connected');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await app.queue;
}

test('start: status, Discovery, every value, badges; read every 60 s', async () => {
  const { gladys, phonetrack, timers } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'PhoneTrack answers: 2 devices, 1 silent for more than 60 min.',
      fr: 'PhoneTrack répond : 2 appareils, 1 muet depuis plus de 60 min.',
    },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [`ext:${SELECTOR}:device:${key('Alice')}`, 'Alice'],
      [`ext:${SELECTOR}:device:${key('Bob')}`, 'Bob'],
    ],
  );
  const [alice, bob] = gladys.fake.discoveredDevices;
  assert.ok(!alice.features.some((f) => f.external_id.endsWith(':satellites')), 'none sent');
  assert.ok(bob.features.some((f) => f.external_id.endsWith(':satellites')));
  assert.equal(last(gladys, 'Alice', 'latitude'), 48.8566);
  assert.equal(last(gladys, 'Alice', 'longitude'), 2.3522);
  assert.equal(last(gladys, 'Alice', 'battery'), 87);
  assert.equal(last(gladys, 'Alice', 'accuracy'), 12.5);
  assert.equal(last(gladys, 'Alice', 'speed'), 9, '2.5 m/s');
  assert.equal(last(gladys, 'Alice', 'altitude'), 35);
  assert.equal(last(gladys, 'Alice', 'bearing'), 90);
  assert.equal(last(gladys, 'Alice', 'last_seen'), '2026-10-18 07:58 UTC');
  assert.equal(last(gladys, 'Alice', 'silent'), 0);
  assert.equal(last(gladys, 'Bob', 'silent'), 1, '90 min without a point');
  assert.equal(last(gladys, 'Bob', 'satellites'), 9);
  assert.equal(last(gladys, 'Bob', 'speed'), undefined, 'unknown: nothing published');
  assert.equal(gladys.fake.transports.length, 2);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'cloud'));
  assert.deepEqual(timers.delays(), [60_000]);
  assert.equal(
    phonetrack.requests[0].url,
    `${URL_}/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`,
  );
  assert.equal(gladys.fake.sceneEvents.length, 0, 'nothing at the first reading');
  await poll(timers);
  assert.equal(phonetrack.requests.length, 2);
  assert.deepEqual(timers.delays(), [60_000]);
});

test('privacy: no token, address, position nor name in the logs or /data', async () => {
  const { gladys, phonetrack, timers, logs, dataDir } = await setup({ config: { token: WRONG } });
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  phonetrack.failures.push({ status: 503 });
  await poll(timers);
  const written = storeText(dataDir);
  for (const secret of [TOKEN, WRONG, 'cloud.example.org', '48.85', '2.35', 'Alice', 'Bob']) {
    assert.ok(!logs.some((l) => l.includes(secret)), `log: ${secret}`);
    assert.ok(!written.includes(secret), `/data: ${secret}`);
  }
  // External ids carry digests, never the token.
  assert.ok(!JSON.stringify(gladys.fake.discoveredDevices).includes(TOKEN));
  assert.ok(!JSON.stringify(gladys.fake.states).includes('Android'), 'no user agent');
});

test('the silent trigger: once per silence and threshold, never at the first reading', async () => {
  const { gladys, phonetrack, timers, clock } = await setup();
  const events = () => gladys.fake.sceneEvents.map((e) => [e.data.device_name, e.data.minutes]);
  // Alice: last point at 07:58. At 08:13 she is silent for 15 min.
  clock.now = T0 + 13 * MIN;
  await poll(timers);
  assert.deepEqual(events(), [['Alice', '15']]);
  const [first] = gladys.fake.sceneEvents;
  assert.equal(first.key, SCENE_TRIGGERS.DEVICE_SILENT);
  assert.deepEqual(first.data, {
    device: `ext:${SELECTOR}:device:${key('Alice')}`,
    minutes: '15',
    device_name: 'Alice',
    silent_for: 15,
    last_seen: '2026-10-18 07:58 UTC',
  });
  clock.now = T0 + 14 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'not twice');
  // Bob was already silent for 90 min at start: 15, 30, 60 never fire; 120 does.
  clock.now = T0 + 30 * MIN;
  await poll(timers);
  assert.deepEqual(events(), [
    ['Alice', '15'],
    ['Alice', '30'],
    ['Bob', '120'],
  ]);
  // A new point ends Alice's silence: the next one fires again.
  phonetrack.devices.Alice = point({ timestamp: (T0 + 31 * MIN) / 1000 });
  clock.now = T0 + 32 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 3);
  assert.equal(last(gladys, 'Alice', 'silent'), 0);
  clock.now = T0 + 46 * MIN;
  await poll(timers);
  assert.deepEqual(events().at(-1), ['Alice', '15']);
  // A late batch of old points keeps the silence: no second event.
  phonetrack.devices.Alice = point({ timestamp: (T0 + 30 * MIN) / 1000 });
  clock.now = T0 + 47 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 4);
  // Bob: 120 fired; a late batch puts him at 100 min: 120 is not fired again.
  phonetrack.devices.Bob = point({ timestamp: (T0 + 48 * MIN - 100 * MIN) / 1000 });
  clock.now = T0 + 48 * MIN;
  await poll(timers);
  clock.now = T0 + 70 * MIN;
  await poll(timers);
  assert.ok(
    !events()
      .slice(4)
      .some(([name]) => name === 'Bob'),
    'no second 120 for Bob',
  );
});

test('a restart of the app (Gladys came back) keeps the silences: no event again', async () => {
  const { gladys, timers, clock, app } = await setup();
  clock.now = T0 + 13 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1);
  await reconnect(gladys, app);
  clock.now = T0 + 14 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1);
});

test('a refused token stops for 1 h, 6 h, 24 h, persisted: never a loop', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pt-app-'));
  const { gladys, phonetrack, timers, app } = await setup({
    config: { token: WRONG },
    dataDir,
  });
  assert.equal(phonetrack.requests.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the token \(HTTP 404/);
  assert.match(gladys.fake.connectionStatus.message.en, /stops for 1 h/);
  assert.deepEqual(timers.delays(), [HOUR]);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'unreachable'));
  // Gladys comes back, the test button: nothing reaches Nextcloud.
  await reconnect(gladys, app);
  assert.match(gladys.fake.connectionStatus.message.en, /refused this token earlier/);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(phonetrack.requests.length, 1);
  // A restart of the container: the stop holds (read from /data).
  await running.stop();
  const second = await setup({ config: { token: WRONG }, dataDir, phonetrack, now: T0 + 10 * MIN });
  assert.equal(phonetrack.requests.length, 1, 'the restart sent nothing');
  assert.deepEqual(second.timers.delays(), [50 * MIN]);
  // The end of the stop: one attempt, refused again: 6 h, then 24 h, 24 h.
  second.clock.now = T0 + HOUR;
  await second.timers.run();
  assert.equal(phonetrack.requests.length, 2);
  assert.deepEqual(second.timers.delays(), [6 * HOUR]);
  second.clock.now += 6 * HOUR;
  await second.timers.run();
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  second.clock.now += 24 * HOUR;
  await second.timers.run();
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  assert.equal(phonetrack.requests.length, 4);
  // Saving the configuration: one attempt at once (refused: still 24 h).
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG, token: WRONG });
  assert.equal(phonetrack.requests.length, 5);
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  // The right token works and the refusal is forgotten.
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.ok(!storeText(dataDir).includes('|'), 'no refusal left');
});

test('401 and 403 are refusals; a 404 page that is not PhoneTrack is retried', async () => {
  for (const status of [401, 403]) {
    const phonetrack = createFakePhonetrack();
    phonetrack.failures.push({ status, body: '<html>Unauthorized</html>' });
    const { gladys, timers } = await setup({ phonetrack });
    assert.match(gladys.fake.connectionStatus.message.en, new RegExp(`HTTP ${status}`));
    assert.deepEqual(timers.delays(), [HOUR]);
    await running.stop();
  }
  const phonetrack = createFakePhonetrack();
  const { gladys, timers } = await setup({
    phonetrack,
    config: { url: `${URL_}/nextcloud` },
  });
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer like PhoneTrack/);
  assert.deepEqual(timers.delays(), [INTERVALS.RETRY_MIN_MS]);
  await timers.run();
  assert.deepEqual(timers.delays(), [2 * INTERVALS.RETRY_MIN_MS], 'doubling');
});

test('HTTP 429: a bounded pause of every path, kept across a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pt-app-'));
  const phonetrack = createFakePhonetrack();
  phonetrack.failures.push({ status: 429, headers: { 'retry-after': '99999999' } });
  const { gladys, timers, app } = await setup({ phonetrack, dataDir });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [INTERVALS.BUSY_MAX_MS], 'capped at 6 h');
  await reconnect(gladys, app);
  assert.equal(phonetrack.requests.length, 1, 'a reconnection does not read');
  assert.match(gladys.fake.connectionStatus.message.en, /pause goes on/);
  await running.stop();
  const second = await setup({ phonetrack, dataDir, now: T0 + HOUR });
  assert.equal(phonetrack.requests.length, 1, 'nor a restart');
  assert.deepEqual(second.timers.delays(), [5 * HOUR]);
  second.clock.now = T0 + 6 * HOUR;
  await second.timers.run();
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.ok(!storeText(dataDir).includes('pausedUntil'), 'forgotten after a reading that works');
});

test('HTTP 429 without Retry-After, and 5xx: paused at least for the interval', async () => {
  const phonetrack = createFakePhonetrack();
  phonetrack.failures.push({ status: 429 }, { status: 503 });
  const { gladys, timers } = await setup({ phonetrack, config: { poll_interval: '300' } });
  assert.deepEqual(timers.delays(), [300_000]);
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503/);
  assert.deepEqual(timers.delays(), [300_000]);
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a failure is never read again faster than the interval, even after a reconnection', async () => {
  const phonetrack = createFakePhonetrack();
  const { gladys, timers, app } = await setup({ phonetrack });
  phonetrack.unreachable = true;
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer: no connection/);
  assert.deepEqual(timers.delays(), [INTERVALS.RETRY_MIN_MS]);
  const before = phonetrack.requests.length;
  await reconnect(gladys, app);
  assert.equal(phonetrack.requests.length, before, 'the wait is not skipped');
  assert.equal(gladys.fake.discoveredDevices.length, 2, 'Discovery from the devices known');
  assert.ok(gladys.fake.transports.at(-1).transport === 'unreachable');
  phonetrack.unreachable = false;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /Connected: 2 devices, 1 silent/);
});

test('the status and Discovery are sent again at every connection to Gladys', async () => {
  const { gladys, app } = await setup();
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await reconnect(gladys, app);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
});

test('a published device never loses a feature of the created one', async () => {
  const bob = device('Bob', { hasSatellites: true });
  bob.features.push({ ...bob.features[0], external_id: `${bob.external_id}:old_feature` });
  const phonetrack = createFakePhonetrack();
  phonetrack.devices.Bob = point({ satellites: null });
  const { gladys } = await setup({ phonetrack, created: [device('Alice'), bob] });
  const published = gladys.fake.discoveredDevices.find((d) => d.name === 'Bob');
  const kept = published.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(kept.includes('satellites'), 'satellites of the created device kept');
  assert.ok(kept.includes('old_feature'));
});

test('the state budget: 250 a minute at most, a position never split', async () => {
  const phonetrack = createFakePhonetrack();
  phonetrack.devices = {};
  const created = [];
  for (let i = 0; i < 60; i += 1) {
    const name = `Phone ${String(i).padStart(2, '0')}`;
    phonetrack.devices[name] = point({ lat: 40 + i / 100, satellites: 5 });
    created.push(device(name, { hasSatellites: true }));
  }
  const { gladys, timers, clock } = await setup({ phonetrack, created });
  assert.match(gladys.fake.connectionStatus.message.en, /60 devices.*10 more devices are left out/);
  const count = () => gladys.fake.states.length;
  assert.ok(count() <= LIMITS.STATES_PER_MINUTE, `${count()} states`);
  const sent = new Set(gladys.fake.states.map((s) => s.device_feature_external_id));
  for (const id of sent) {
    if (id.endsWith(':latitude')) assert.ok(sent.has(id.replace(/latitude$/, 'longitude')));
  }
  for (let i = 0; i < LIMITS.DEVICES; i += 1) {
    const name = `Phone ${String(i).padStart(2, '0')}`;
    assert.equal(last(gladys, name, 'silent'), 0, 'the silent states go first');
  }
  // Within the same minute, nothing more; the rest goes later.
  await poll(timers);
  assert.ok(count() <= LIMITS.STATES_PER_MINUTE);
  for (let minute = 1; minute <= 3; minute += 1) {
    clock.now = T0 + minute * MIN + 1;
    await poll(timers);
  }
  assert.equal(
    last(gladys, 'Phone 49', 'last_seen'),
    '2026-10-18 07:58 UTC',
    'all sent in the end',
  );
  assert.equal(last(gladys, 'Phone 55', 'silent'), undefined, 'above the cap: nothing');
});

test('read only: every command is refused, nothing reaches PhoneTrack', async () => {
  const { gladys, phonetrack } = await setup();
  const alice = device('Alice');
  const before = phonetrack.requests.length;
  for (const feature of alice.features) {
    const ack = await gladys.fake.setValue(alice, feature, 0);
    assert.equal(ack.success, false);
    assert.match(ack.error, /only reads PhoneTrack/);
  }
  assert.equal(phonetrack.requests.length, before);
});

test('configuration errors: said, nothing sent', async () => {
  const cases = [
    [{ url: '', token: TOKEN }, /Type the address of your Nextcloud/],
    [{ url: 'http://cloud.example.org' }, /in clear/],
    [{ url: `${URL_}/apps/phonetrack/api/getlastpositions/${TOKEN}` }, /token field/],
    [
      {
        url: 'https://other.example.org',
        token: `${URL_}/apps/phonetrack/api/getlastpositions/${TOKEN}`,
      },
      /another server/,
    ],
    [{ token: '' }, /Paste the public token/],
    [{ token: 'bad token' }, /not a PhoneTrack token/],
    [{ certificate_fingerprint: 'nope' }, /SHA-256/],
  ];
  for (const [config, message] of cases) {
    const { gladys, phonetrack, timers } = await setup({ config });
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.en, message);
    assert.equal(phonetrack.requests.length, 0);
    assert.equal(timers.pending.size, 0);
    await running.stop();
  }
});

test('the API link alone in the token field is enough', async () => {
  const { gladys, phonetrack } = await setup({
    config: { url: '', token: `${URL_}/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}` },
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    phonetrack.requests[0].url,
    `${URL_}/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`,
  );
});

test('an empty session; a device removed in PhoneTrack turns unreachable', async () => {
  const phonetrack = createFakePhonetrack();
  const { gladys, timers } = await setup({ phonetrack });
  delete phonetrack.devices.Bob;
  await poll(timers);
  const badges = Object.fromEntries(
    gladys.fake.transports.map((t) => [t.device_external_id, t.transport]),
  );
  assert.equal(badges[`ext:${SELECTOR}:device:${key('Bob')}`], 'unreachable');
  assert.equal(badges[`ext:${SELECTOR}:device:${key('Alice')}`], 'cloud');
  phonetrack.devices = {};
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /no device with a position yet/);
});

test('Discovery (scan): one reading, published', async () => {
  const { gladys, phonetrack } = await setup();
  const before = phonetrack.requests.length;
  await gladys.fake.scanRequest();
  assert.equal(phonetrack.requests.length, before + 1);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

const NOT_FOUND = { status: 404, body: '{"error":"Session not found"}' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Hold the next answers of the fake PhoneTrack until release() is called. */
function hold(phonetrack) {
  let release;
  phonetrack.gate = new Promise((resolve) => {
    release = () => {
      phonetrack.gate = null;
      resolve();
    };
  });
  return () => release();
}

for (const [label, failure, delay, message] of [
  ['a refusal', NOT_FOUND, HOUR, /refused this token earlier/],
  ['a 429', { status: 429, headers: { 'retry-after': '3600' } }, HOUR, /pause goes on/],
]) {
  test(`${label} answered while Gladys was away is kept: the reconnection waits`, async () => {
    const { gladys, phonetrack, timers, app } = await setup();
    phonetrack.failures.push(failure);
    const release = hold(phonetrack);
    const sent = phonetrack.requests.length;
    const polling = poll(timers);
    for (let i = 0; i < 100 && phonetrack.requests.length === sent; i += 1) await tick();
    assert.equal(phonetrack.requests.length, sent + 1, 'the request left');
    gladys.emit('disconnected');
    await tick();
    release();
    await polling;
    const requests = phonetrack.requests.length;
    await reconnect(gladys, app);
    assert.equal(phonetrack.requests.length, requests, 'nothing sent at the reconnection');
    assert.deepEqual(timers.delays(), [delay]);
    assert.match(gladys.fake.connectionStatus.message.en, message);
  });
}

test('an attempt after a refusal still in flight at a restart counts as a refusal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pt-app-'));
  const { phonetrack, timers, clock } = await setup({ config: { token: WRONG }, dataDir });
  clock.now = T0 + HOUR;
  const release = hold(phonetrack);
  const attempt = timers.run();
  for (let i = 0; i < 100 && phonetrack.requests.length < 2; i += 1) await tick();
  assert.equal(phonetrack.requests.length, 2, 'the attempt left');
  // The container restarts before the answer.
  const second = await setup({ config: { token: WRONG }, dataDir, phonetrack, now: T0 + HOUR });
  assert.equal(phonetrack.requests.length, 2);
  assert.deepEqual(second.timers.delays(), [6 * HOUR], 'one more step');
  release();
  await attempt;
});

test('saving the same refused token: one forced attempt per series of refusals', async () => {
  const { gladys, phonetrack } = await setup({ config: { token: WRONG } });
  assert.equal(phonetrack.requests.length, 1);
  for (let i = 0; i < 5; i += 1) await gladys.fake.configUpdated({ ...BASE_CONFIG, token: WRONG });
  assert.equal(phonetrack.requests.length, 2, '5 saves, 1 request');
  assert.match(gladys.fake.connectionStatus.message.en, /Already tried again.*next attempt in 6 h/);
  // Another token is tried at once.
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(phonetrack.requests.length, 3);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('within a series of refusals, a timeout waits for the end of the step', async () => {
  const { gladys, phonetrack, timers, clock } = await setup({ config: { token: WRONG } });
  phonetrack.unreachable = true;
  clock.now = T0 + HOUR;
  await timers.run();
  assert.equal(phonetrack.requests.length, 2);
  assert.deepEqual(timers.delays(), [HOUR], 'not one minute');
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer/);
});

test('a refusal read back is capped by the delay of its own step', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pt-app-'));
  const { phonetrack } = await setup({ config: { token: WRONG }, dataDir });
  await running.stop();
  // The clock went back 20 h: the 1 h stop would otherwise last 21 h.
  const second = await setup({
    config: { token: WRONG },
    dataDir,
    phonetrack,
    now: T0 - 20 * HOUR,
  });
  assert.deepEqual(second.timers.delays(), [HOUR]);
});

test('403: a refusal, the status names a firewall or a proxy', async () => {
  const phonetrack = createFakePhonetrack();
  phonetrack.failures.push({ status: 403, body: '<html>Forbidden</html>' });
  const { gladys, timers } = await setup({ phonetrack });
  assert.match(gladys.fake.connectionStatus.message.en, /firewall \/ proxy blocks Gladys/);
  assert.deepEqual(timers.delays(), [HOUR]);
});

test('one device with an absurd date never blocks the others', async () => {
  const phonetrack = createFakePhonetrack();
  phonetrack.devices.Bob = point({ timestamp: 1e15 });
  const { gladys } = await setup({ phonetrack });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'Alice', 'latitude'), 48.8566);
  assert.equal(last(gladys, 'Bob', 'last_seen'), undefined, 'no date');
  assert.equal(last(gladys, 'Bob', 'battery'), 87);
});

test('an internal error is never shown as Nextcloud not answering; too large is said', async () => {
  const { gladys, timers, app, logs } = await setup();
  app.statesOf = () => {
    throw new TypeError('boom');
  };
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /Internal error of the integration/);
  assert.ok(logs.some((l) => l.startsWith('error Internal error')));
  delete app.statesOf;
  const big = createFakePhonetrack();
  big.request = async () => {
    const { PhonetrackError, CODES } = await import('../src/phonetrack/errors.js');
    throw new PhonetrackError(CODES.TOO_LARGE, 'Answer above 2097152 bytes');
  };
  const second = await setup({ phonetrack: big });
  assert.match(second.gladys.fake.connectionStatus.message.en, /answer is too large/);
  assert.doesNotMatch(second.gladys.fake.connectionStatus.message.en, /does not answer/);
});

test('only the devices created in Gladys fire; a point in the future is no baseline', async () => {
  const phonetrack = createFakePhonetrack();
  // Carol is not created; Dan's point is 10 min in the future (Gladys late).
  phonetrack.devices.Carol = point();
  phonetrack.devices.Dan = point({ timestamp: (T0 + 10 * MIN) / 1000 });
  const { gladys, timers, clock } = await setup({
    phonetrack,
    created: [device('Alice'), device('Bob', { hasSatellites: true }), device('Dan')],
  });
  // The clock of Gladys is set right: Dan is in fact 20 min silent.
  clock.now = T0 + 30 * MIN;
  await poll(timers);
  const names = gladys.fake.sceneEvents.map((e) => e.data.device_name);
  assert.ok(!names.includes('Carol'), 'not created: no event');
  assert.ok(!names.includes('Dan'), 'first real reading of Dan: baseline');
  assert.ok(names.includes('Alice'));
});

test('a jump of the wall clock makes the reading a new baseline', async () => {
  const { gladys, timers, clock } = await setup();
  clock.now = T0 + 20 * MIN;
  clock.jump = 19 * MIN; // the wall clock moved 19 min more than the monotonic one
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'Alice crossed 15 min only through the jump');
  clock.now = T0 + 40 * MIN;
  await poll(timers);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => [e.data.device_name, e.data.minutes]),
    [
      ['Alice', '30'],
      ['Bob', '120'],
    ],
    'only what was crossed after the jump',
  );
});

test('30 events per reading at most: the rest leaves at the next reading', async () => {
  const phonetrack = createFakePhonetrack();
  phonetrack.devices = {};
  const created = [];
  for (let i = 0; i < 40; i += 1) {
    const name = `P${String(i).padStart(2, '0')}`;
    phonetrack.devices[name] = point({ timestamp: (T0 - MIN) / 1000 });
    created.push(device(name));
  }
  const { gladys, timers, clock } = await setup({ phonetrack, created });
  clock.now = T0 + 14 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 30);
  clock.now = T0 + 15 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 40, 'the 10 others, once');
  clock.now = T0 + 16 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 40);
});

test('the cap of 50 keeps the created devices first', async () => {
  const phonetrack = createFakePhonetrack();
  phonetrack.devices = {};
  for (let i = 0; i < 60; i += 1) phonetrack.devices[`P${String(i).padStart(2, '0')}`] = point();
  const { gladys } = await setup({ phonetrack, created: [device('P59')] });
  assert.equal(last(gladys, 'P59', 'latitude'), 48.8566, 'created: followed beyond the 50th');
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.equal(names.length, 50);
  assert.ok(names.includes('P59') && !names.includes('P49'));
});

test('the configuration of Gladys cannot be read: the last one, or a status and a timer', async () => {
  const { gladys, phonetrack, timers, app } = await setup();
  gladys.getConfig = async () => {
    throw new Error('HTTP 500');
  };
  const before = phonetrack.requests.length;
  await reconnect(gladys, app);
  assert.equal(phonetrack.requests.length, before + 1, 'the last configuration received');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  gladys.config = {};
  await reconnect(gladys, app);
  assert.match(gladys.fake.connectionStatus.message.en, /did not give the configuration/);
  assert.deepEqual(timers.delays(), [60_000]);
});
