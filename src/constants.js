// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the trigger keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

export const SCENE_TRIGGERS = Object.freeze({
  DEVICE_SILENT: 'device_silent',
});

/**
 * Device external ids: `ext:<selector>:device:<session key>-<device key>`,
 * both keys hexadecimal digests (src/devices.js): the session key comes from
 * the share token (never the token itself), the device key from the name of
 * the PhoneTrack device.
 */
export const DEVICE_TYPE = 'device';

export const FEATURES = Object.freeze({
  LATITUDE: 'latitude',
  LONGITUDE: 'longitude',
  BATTERY: 'battery',
  ACCURACY: 'accuracy',
  SPEED: 'speed',
  ALTITUDE: 'altitude',
  BEARING: 'bearing',
  SATELLITES: 'satellites',
  LAST_SEEN: 'last_seen',
  SILENT: 'silent',
});

/** Seconds between two readings. */
export const POLL_INTERVALS = Object.freeze(['30', '60', '120', '300', '600']);

/**
 * Minutes without a new point after which a device is silent: the choices of
 * the configuration (the "Silent" feature) and of the scene trigger filter.
 */
export const SILENT_MINUTES = Object.freeze(['15', '30', '60', '120', '240', '480', '720', '1440']);

/** Caps: what is read, published and fired. */
export const LIMITS = Object.freeze({
  /** Devices followed in the session (the rest is counted in the status). */
  DEVICES: 50,
  /** Scene events sent in one reading. */
  EVENTS_PER_ROUND: 30,
  /** POST /state admits 300 states per minute per integration: stay under 250. */
  STATES_PER_MINUTE: 250,
  /** A device name published to Gladys is cut to this length. */
  NAME_LENGTH: 100,
});

export const TIMEOUTS = Object.freeze({
  /**
   * One request. Nextcloud's brute-force protection slows the answers of an
   * address it suspects (up to 25 s) before it refuses them (HTTP 429).
   */
  API: 30_000,
});

export const INTERVALS = Object.freeze({
  /** A failure (network, TLS, unexpected answer) is retried after max(this, the poll interval), doubling. */
  RETRY_MIN_MS: 60_000,
  RETRY_MAX_MS: 30 * 60_000,
  /** HTTP 429 or 5xx: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /**
   * The share refused (401 / 403, or 404 "Session not found"): a stop of 1 h,
   * then 6 h, then 24 h for every refusal after (never a loop: Nextcloud
   * counts each refusal as a brute-force attempt).
   */
  REFUSAL_STEPS_MS: Object.freeze([3600_000, 6 * 3600_000, 24 * 3600_000]),
});

/** Size cap of an answer read from PhoneTrack. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** The persistent store (refusals, pauses: see src/store.js). */
export const STORE_FILE = 'phonetrack.json';

/** The path of the read-only API of PhoneTrack, after the Nextcloud address. */
export const API_PATH = '/index.php/apps/phonetrack/api/getlastpositions/';
