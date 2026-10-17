// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   device   `ext:<selector>:device:<session key>-<device key>`
//            one per PhoneTrack device of the session: latitude, longitude,
//            battery, accuracy, speed, altitude, bearing, satellites (when the
//            logger sends them), last seen (text) and silent (read-only binary)
//
// The keys are digests: the session key comes from the public token (never
// the token itself: it is a secret), the device key from the device name.
// Both are stable; renaming a device in PhoneTrack makes a new device.
//
// A device published again never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history of the missing
// one. The features of the device created in Gladys (`gladys.devices`, kept
// up to date by the SDK) are added back when the blueprint lacks them.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS } from './constants.js';

export const ID_PATTERN = /^[0-9a-f]{10}-[0-9a-f]{16}$/;

const digest = (label, value, length) =>
  createHash('sha256').update(`gladys-phonetrack:${label}:${value}`).digest('hex').slice(0, length);

/** The session part of the external ids: a digest of the token (never the token). */
export const sessionKey = (token) => digest('session', token, 10);

/** The id of a PhoneTrack device in Gladys: session key and a digest of its name. */
export const deviceKey = (token, name) => `${sessionKey(token)}-${digest('device', name, 16)}`;

export const deviceIds = (gladys, key) => gladys.externalIds(DEVICE_TYPE, key);

const readOnly = (extra) => ({ read_only: true, has_feedback: false, ...extra });

const feature = (ids, key, name, spec, keepHistory = false) => ({
  name,
  external_id: ids.feature(key),
  ...readOnly(spec),
  keep_history: keepHistory,
});

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(gladys, device, devices = gladys.devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/**
 * Units and types: only the pairs and units the core lists
 * (server/utils/constants.js: DEVICE_FEATURE_UNITS_BY_CATEGORY). The core has
 * no category for coordinates: latitude and longitude are `unknown`/`unknown`
 * without unit; the bearing is `angle-sensor`, which takes no unit.
 * Positions keep no history by default (privacy; the user may turn it on).
 *
 * @param {{ key: string, name: string, hasSatellites?: boolean }} device
 */
export function buildDevice(gladys, { key, name, hasSatellites = false }) {
  const ids = deviceIds(gladys, key);
  const features = [
    feature(ids, FEATURES.LATITUDE, 'Latitude', {
      category: C.UNKNOWN,
      type: T.UNKNOWN.UNKNOWN,
      min: -90,
      max: 90,
    }),
    feature(ids, FEATURES.LONGITUDE, 'Longitude', {
      category: C.UNKNOWN,
      type: T.UNKNOWN.UNKNOWN,
      min: -180,
      max: 180,
    }),
    feature(
      ids,
      FEATURES.BATTERY,
      'Battery',
      { category: C.BATTERY, type: T.BATTERY.INTEGER, unit: U.PERCENT, min: 0, max: 100 },
      true,
    ),
    feature(ids, FEATURES.ACCURACY, 'Accuracy', {
      category: C.DISTANCE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.M,
      min: 0,
      max: 1_000_000,
    }),
    feature(ids, FEATURES.SPEED, 'Speed', {
      category: C.SPEED_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.KILOMETER_PER_HOUR,
      min: 0,
      max: 3600,
    }),
    feature(ids, FEATURES.ALTITUDE, 'Altitude', {
      category: C.DISTANCE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.M,
      min: -1000,
      max: 100_000,
    }),
    feature(ids, FEATURES.BEARING, 'Bearing', {
      category: C.ANGLE_SENSOR,
      type: T.SENSOR.INTEGER,
      min: 0,
      max: 359,
    }),
  ];
  if (hasSatellites) {
    features.push(
      feature(ids, FEATURES.SATELLITES, 'Satellites', {
        category: C.COUNTER_SENSOR,
        type: T.SENSOR.INTEGER,
        min: 0,
        max: 200,
      }),
    );
  }
  features.push(
    feature(ids, FEATURES.LAST_SEEN, 'Last seen', {
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
    }),
    // Never a switch: the core hands every switch to the voice assistants,
    // MCP and the switch scene actions. Read-only `unknown`/`binary`.
    feature(
      ids,
      FEATURES.SILENT,
      'Silent',
      { category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 },
      true,
    ),
  );
  return withCreatedFeatures(gladys, {
    name: name.slice(0, LIMITS.NAME_LENGTH),
    external_id: ids.device,
    model: 'PhoneTrack device',
    should_poll: false,
    features,
  });
}

/**
 * What a device or feature external id of this integration designates:
 * { key, feature } | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [key, featureKey, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0 || !ID_PATTERN.test(key ?? '')) return null;
  return { key, feature: featureKey ?? null };
}

/** The created devices of this integration: [{ key, externalId }]. */
export function createdDevices(gladys, devices = gladys.devices) {
  const list = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    list.push({ key: parsed.key, externalId: device.external_id });
  }
  return list;
}
