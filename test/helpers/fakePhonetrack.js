// -----------------------------------------------------------------------------
// A fake PhoneTrack (in memory, or on loopback through listen()): the one GET
// the integration uses. The shape comes from PhoneTrack's routes and
// controller (appinfo/routes.php, APIgetLastPositionsPublic), read only; never
// checked against a real Nextcloud (TODO.md). Test positions are made up.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { CODES, PhonetrackError } from '../../src/phonetrack/errors.js';

export const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const PATH = `/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`;

export function point(options = {}) {
  return {
    useragent: 'PhoneTrack/0.8 Android',
    lat: 48.8566,
    lon: 2.3522,
    timestamp: Date.parse('2026-10-18T07:58:00Z') / 1000,
    batterylevel: 87,
    satellites: null,
    accuracy: 12.5,
    altitude: 35,
    speed: 2.5,
    bearing: 90,
    ...options,
  };
}

export function createFakePhonetrack() {
  const fake = {
    requests: [],
    devices: {
      Alice: point(),
      Bob: point({
        lat: 45.764,
        lon: 4.8357,
        timestamp: Date.parse('2026-10-18T06:30:00Z') / 1000,
        batterylevel: 15,
        satellites: 9,
        speed: null,
        bearing: null,
      }),
    },
    /** { status, headers, body } answered once each (FIFO). */
    failures: [],
    unreachable: false,
    /** Requests waiting for their answer, and the most at once. */
    inFlight: 0,
    maxInFlight: 0,
    /** A promise the API waits for before answering (a slow reading). */
    gate: null,
  };

  const json = (status, value, headers = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  });

  function answer(url) {
    if (fake.failures.length > 0) {
      const f = fake.failures.shift();
      if (f.body !== undefined) {
        return { status: f.status, headers: f.headers ?? {}, body: Buffer.from(f.body) };
      }
      return json(f.status, { error: 'failure' }, f.headers ?? {});
    }
    const prefix = '/index.php/apps/phonetrack/api/getlastpositions/';
    if (!url.pathname.startsWith(prefix))
      return { status: 404, headers: {}, body: Buffer.from('<html>Not found</html>') };
    const token = decodeURIComponent(url.pathname.slice(prefix.length));
    if (token !== TOKEN) return json(404, { error: 'Session not found' });
    const devices = Object.keys(fake.devices).length === 0 ? [] : fake.devices;
    return json(200, { [TOKEN]: devices });
  }

  /** The transport of src/phonetrack/http.js, in memory. */
  fake.request = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    fake.requests.push({ url: rawUrl, path: url.pathname, headers, options });
    fake.inFlight += 1;
    fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
    try {
      if (fake.gate) await fake.gate;
      if (fake.unreachable) throw new PhonetrackError(CODES.UNREACHABLE, 'ECONNREFUSED');
      return answer(url);
    } finally {
      fake.inFlight -= 1;
    }
  };

  /** The same API on a loopback server (https when `tls` gives key and cert): { url, port, close }. */
  fake.listen = async (tls) => {
    const listener = (req, res) => {
      req.resume();
      req.on('end', () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        fake.requests.push({ url: req.url, path: url.pathname, headers: req.headers });
        const result = answer(url);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      });
    };
    const server = tls ? https.createServer(tls, listener) : http.createServer(listener);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
      url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
      port,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        }),
    };
  };

  return fake;
}
