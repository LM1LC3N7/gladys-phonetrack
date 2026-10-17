import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, parseDevice, parseLastPositions } from '../src/phonetrack/parse.js';
import { point } from './helpers/fakePhonetrack.js';

const TOKEN = 'tok123456';

test('a full point: units converted, the user agent dropped', () => {
  const device = parseDevice('Alice', point({ satellites: 7, bearing: 359.6 }));
  assert.deepEqual(device, {
    name: 'Alice',
    lat: 48.8566,
    lon: 2.3522,
    timestampMs: Date.parse('2026-10-18T07:58:00Z'),
    battery: 87,
    accuracy: 12.5,
    altitude: 35,
    speedKmh: 9,
    bearing: 0,
    satellites: 7,
  });
  assert.ok(!JSON.stringify(device).includes('Android'));
});

test('missing or absurd values are null; a lone coordinate is no position', () => {
  const device = parseDevice(
    'X',
    point({
      lat: 91,
      batterylevel: -1,
      accuracy: null,
      altitude: 'high',
      speed: -3,
      bearing: 400,
      satellites: 1000,
      timestamp: null,
    }),
  );
  assert.equal(device.lat, null);
  assert.equal(device.lon, null);
  assert.equal(device.battery, null);
  assert.equal(device.accuracy, null);
  assert.equal(device.altitude, null);
  assert.equal(device.speedKmh, null);
  assert.equal(device.bearing, null);
  assert.equal(device.satellites, null);
  assert.equal(device.timestampMs, null);
  assert.equal(parseDevice('', point()), null);
  assert.equal(parseDevice('X', null), null);
  assert.equal(parseDevice('X', [1]), null);
  assert.equal(parseDevice('Y', point({ lat: 1.23456789 })).lat, 1.234568);
});

test('the answer: keyed by the token, sorted, empty as [], anything else refused', () => {
  const devices = parseLastPositions({ [TOKEN]: { Zoe: point(), Alice: point() } }, TOKEN);
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Alice', 'Zoe'],
  );
  assert.deepEqual(parseLastPositions({ [TOKEN]: [] }, TOKEN), []);
  assert.equal(parseLastPositions({ other: { A: point() } }, TOKEN).length, 1, 'one entry');
  assert.equal(parseLastPositions({ error: 'Session not found' }, TOKEN), null);
  assert.equal(parseLastPositions({ a: {}, b: {} }, TOKEN), null);
  assert.equal(parseLastPositions([], TOKEN), null);
  assert.equal(parseLastPositions(null, TOKEN), null);
  assert.equal(parseLastPositions({ [TOKEN]: 'x' }, TOKEN), null);
  assert.deepEqual(parseLastPositions({ [TOKEN]: { A: 'bad' } }, TOKEN), []);
});

test('dates in UTC', () => {
  assert.equal(formatDate(Date.parse('2026-10-18T07:58:30Z')), '2026-10-18 07:58 UTC');
  assert.equal(formatDate(null), null);
  assert.equal(formatDate(Number.NaN), null);
});
