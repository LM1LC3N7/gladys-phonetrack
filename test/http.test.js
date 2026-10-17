// -----------------------------------------------------------------------------
// The real transport (node:http / node:https) against loopback servers only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { PhonetrackClient } from '../src/phonetrack/client.js';
import { CODES, isRefused } from '../src/phonetrack/errors.js';
import { httpRequest } from '../src/phonetrack/http.js';
import { TOKEN, createFakePhonetrack } from './helpers/fakePhonetrack.js';

const tlsFile = (name) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));
const TLS = { key: tlsFile('server.key'), cert: tlsFile('server.pem') };
const certFingerprint = new X509Certificate(tlsFile('server.pem')).fingerprint256;

async function serve(handler, { secure = false } = {}) {
  const requests = [];
  const listener = (req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    });
  };
  const server = secure ? https.createServer(TLS, listener) : http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const okJson = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('[]');
};

test('GET, the size cap, no redirect followed', async () => {
  const server = await serve((req, res) => {
    if (req.url.startsWith('/big')) {
      res.writeHead(200);
      res.end(Buffer.alloc(5000));
      return;
    }
    if (req.url.startsWith('/moved')) {
      res.writeHead(302, { location: 'https://elsewhere.example/' });
      res.end();
      return;
    }
    okJson(req, res);
  });
  try {
    const get = await httpRequest(`${server.url}/a?b=1`, {
      timeout: 2000,
      maxBytes: 1000,
      allowHttp: true,
    });
    assert.equal(get.status, 200);
    assert.equal(get.body.toString(), '[]');
    assert.equal(server.requests[0].method, 'GET');
    await assert.rejects(
      httpRequest(`${server.url}/big`, { timeout: 2000, maxBytes: 1000, allowHttp: true }),
      (err) => err.code === CODES.TOO_LARGE,
    );
    const moved = await httpRequest(`${server.url}/moved`, {
      timeout: 2000,
      maxBytes: 1000,
      allowHttp: true,
    });
    assert.equal(moved.status, 302);
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
  }
});

test('plain http is refused unless a test allows it: nothing is sent', async () => {
  const server = await serve(okJson);
  try {
    await assert.rejects(
      httpRequest(`${server.url}/secret-token`, { timeout: 2000, maxBytes: 1000 }),
      (err) => err.name === 'PhonetrackError' && !err.message.includes('secret-token'),
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('no answer in time, nobody listening; no error names the address', async () => {
  const server = await serve(() => {}); // never answers
  try {
    await assert.rejects(
      httpRequest(`${server.url}/tok`, { timeout: 200, maxBytes: 1000, allowHttp: true }),
      (err) => err.code === CODES.TIMEOUT,
    );
  } finally {
    await server.close();
  }
  await assert.rejects(
    httpRequest(`${server.url}/tok`, { timeout: 2000, maxBytes: 1000, allowHttp: true }),
    (err) => err.code === CODES.UNREACHABLE && !err.message.includes('127.0.0.1'),
  );
});

test('https: a certificate of an unknown authority is refused by default, before any request', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    await assert.rejects(
      httpRequest(`${server.url}/tok`, { timeout: 2000, maxBytes: 1000 }),
      (err) => err.code === CODES.TLS_UNTRUSTED,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('https, typed fingerprint: exactly this certificate, nothing else', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    const ok = await httpRequest(`${server.url}/a`, {
      timeout: 2000,
      maxBytes: 1000,
      tls: { fingerprint: certFingerprint.replace(/:/g, '').toLowerCase() },
    });
    assert.equal(ok.status, 200);
    await assert.rejects(
      httpRequest(`${server.url}/secret-token`, {
        timeout: 2000,
        maxBytes: 1000,
        tls: { fingerprint: 'AB'.repeat(32) },
      }),
      (err) => err.code === CODES.TLS_CHANGED,
    );
    assert.equal(server.requests.length, 1, 'the token never left');
  } finally {
    await server.close();
  }
});

test('the client sends its user-agent and the token only in the path', async () => {
  const fake = createFakePhonetrack();
  const client = new PhonetrackClient({
    server: { base: 'https://x.test' },
    token: TOKEN,
    request: fake.request,
  });
  const devices = await client.lastPositions();
  assert.equal(devices.length, 2);
  assert.match(fake.requests[0].headers['user-agent'], /^gladys-phonetrack\/\d+\.\d+\.\d+$/);
  assert.equal(fake.requests[0].headers.authorization, undefined);
  assert.equal(
    fake.requests[0].url,
    `https://x.test/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`,
  );
});

test('the client over the real transport; what a refusal is', async () => {
  const fake = createFakePhonetrack();
  const server = await fake.listen(TLS);
  try {
    const client = new PhonetrackClient({
      server: { base: `https://127.0.0.1:${server.port}` },
      token: TOKEN,
      fingerprint: certFingerprint,
    });
    assert.equal((await client.lastPositions()).length, 2);
    // A token PhoneTrack does not know: its own 404 answer, a refusal.
    const wrong = new PhonetrackClient({
      server: { base: `https://127.0.0.1:${server.port}` },
      token: 'ffffffffffffffffffffffffffffffff',
      fingerprint: certFingerprint,
    });
    await assert.rejects(wrong.lastPositions(), (err) => err.status === 404 && isRefused(err));
    // A 404 page that is not PhoneTrack's (wrong folder, app missing): not a refusal.
    const elsewhere = new PhonetrackClient({
      server: { base: `https://127.0.0.1:${server.port}/nextcloud` },
      token: TOKEN,
      fingerprint: certFingerprint,
    });
    await assert.rejects(elsewhere.lastPositions(), (err) => err.status === 404 && !isRefused(err));
    for (const status of [401, 403]) {
      fake.failures.push({ status, body: '<html>no</html>' });
      await assert.rejects(
        client.lastPositions(),
        (err) => err.status === status && isRefused(err),
      );
    }
    fake.failures.push({ status: 429, headers: { 'retry-after': '120' } });
    await assert.rejects(
      client.lastPositions(),
      (err) => err.status === 429 && err.retryAfterMs === 120_000 && !isRefused(err),
    );
    fake.failures.push({ status: 503 });
    await assert.rejects(client.lastPositions(), (err) => err.status === 503 && !isRefused(err));
    fake.failures.push({ status: 200, body: 'not json' });
    await assert.rejects(client.lastPositions(), (err) => err.code === CODES.BAD_ANSWER);
    fake.failures.push({ status: 200, body: '{"a":1,"b":2}' });
    await assert.rejects(client.lastPositions(), (err) => err.code === CODES.BAD_ANSWER);
    client.close();
    await assert.rejects(client.lastPositions(), (err) => err.code === CODES.CLOSED);
  } finally {
    await server.close();
  }
});
