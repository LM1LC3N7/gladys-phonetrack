// -----------------------------------------------------------------------------
// The answer of PhoneTrack's `api/getlastpositions/<token>` -> plain objects.
//
// Shape (read in PhoneTrack's routes and controller, never its code reused):
//   { "<token>": { "<device name>": { lat, lon, timestamp, batterylevel,
//     satellites, accuracy, altitude, speed, bearing, useragent } } }
// Numbers are floats or null; `timestamp` is in seconds, `speed` in m/s (what
// PhoneTrack's own pages assume), `bearing` in degrees, `accuracy` and
// `altitude` in meters. The user agent is never kept.
// -----------------------------------------------------------------------------

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const within = (value, min, max) => {
  const n = finite(value);
  return n !== null && n >= min && n <= max ? n : null;
};
const round = (value, digits) => {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** One device entry, or null when it holds no usable position. */
export function parseDevice(name, entry) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const lat = within(entry.lat, -90, 90);
  const lon = within(entry.lon, -180, 180);
  // Seconds since 1970, bounded (0 < s < 1e11): a date Node cannot write
  // (or a timestamp in ms) is no date.
  const seconds = within(entry.timestamp, Number.MIN_VALUE, 1e11 - 1);
  const speed = within(entry.speed, 0, 1000);
  let bearing = within(entry.bearing, 0, 360);
  if (bearing !== null) bearing = Math.round(bearing) % 360;
  const satellites = within(entry.satellites, 0, 200);
  return {
    name,
    // A position needs both coordinates (a lone one is never published).
    lat: lat !== null && lon !== null ? round(lat, 6) : null,
    lon: lat !== null && lon !== null ? round(lon, 6) : null,
    timestampMs: seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null,
    // Some loggers send -1 when they do not know.
    battery: within(entry.batterylevel, 0, 100) === null ? null : Math.round(entry.batterylevel),
    accuracy: round(within(entry.accuracy, 0, 1_000_000), 1),
    altitude: round(within(entry.altitude, -1000, 100_000), 1),
    speedKmh: speed === null ? null : round(speed * 3.6, 1),
    bearing,
    satellites: satellites === null ? null : Math.round(satellites),
  };
}

/**
 * The devices of the session, sorted by name, or null when the answer is not
 * PhoneTrack's. The answer is keyed by the token; when it is not (a server
 * that echoes another key), its only entry is taken.
 */
export function parseLastPositions(value, token) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let session = Object.hasOwn(value, token) ? value[token] : undefined;
  if (session === undefined) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] === 'error') return null;
    session = value[keys[0]];
  }
  // PHP encodes an empty map as [], and a map with keys 0..n-1 as a list:
  // the names are then the indexes.
  if (!session || typeof session !== 'object') return null;
  const devices = [];
  for (const [name, entry] of Object.entries(session)) {
    // One unreadable device never blocks the others.
    try {
      const device = parseDevice(name, entry);
      if (device) devices.push(device);
    } catch {
      // skipped
    }
  }
  devices.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return devices;
}

/** `YYYY-MM-DD HH:MM UTC`, or null. */
export function formatDate(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
