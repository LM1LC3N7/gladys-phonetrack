import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseServerUrl, parseToken } from '../src/config.js';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('the Nextcloud address: https, a folder kept, the PhoneTrack part dropped', () => {
  assert.deepEqual(parseServerUrl('cloud.example.org'), {
    base: 'https://cloud.example.org',
    hostname: 'cloud.example.org',
    port: 443,
  });
  assert.equal(parseServerUrl('https://Cloud.Example.org/').base, 'https://cloud.example.org');
  assert.equal(
    parseServerUrl('https://example.org/nextcloud/').base,
    'https://example.org/nextcloud',
  );
  assert.equal(
    parseServerUrl('https://example.org/nextcloud/index.php').base,
    'https://example.org/nextcloud',
  );
  assert.equal(
    parseServerUrl('https://example.org/index.php/apps/phonetrack/').base,
    'https://example.org',
  );
  assert.equal(parseServerUrl('https://example.org:8443').base, 'https://example.org:8443');
  assert.equal(parseServerUrl('https://example.org:443').base, 'https://example.org');
  assert.equal(parseServerUrl('https://[::1]:8443').base, 'https://[::1]:8443');
});

test('the Nextcloud address: what is refused', () => {
  assert.deepEqual(parseServerUrl(''), { error: 'missing' });
  assert.deepEqual(parseServerUrl('http://cloud.example.org'), { error: 'http' });
  assert.deepEqual(parseServerUrl('https://u:p@cloud.example.org'), { error: 'credentials' });
  assert.deepEqual(parseServerUrl('https://cloud.example.org/?a=1'), { error: 'invalid' });
  assert.deepEqual(parseServerUrl('ftp://cloud.example.org'), { error: 'invalid' });
  assert.deepEqual(parseServerUrl('https://exa mple.org'), { error: 'invalid' });
  // A link with the token in the field shown in clear.
  assert.deepEqual(
    parseServerUrl(`https://cloud.example.org/apps/phonetrack/api/getlastpositions/${TOKEN}`),
    { error: 'link' },
  );
});

test('the token field: a token, or a link of PhoneTrack that carries it', () => {
  assert.deepEqual(parseToken(` ${TOKEN} `), { token: TOKEN, linkServer: null });
  for (const link of [
    `https://cloud.example.org/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`,
    `https://cloud.example.org/apps/phonetrack/api/getlastpositions/${TOKEN}`,
    `https://cloud.example.org/apps/phonetrack/api/getpositions/${TOKEN}?limit=number`,
  ]) {
    const parsed = parseToken(link);
    assert.equal(parsed.token, TOKEN, link);
    assert.equal(parsed.linkServer.base, 'https://cloud.example.org', link);
  }
  // Watch pages (public session, filtered share): not supported.
  for (const link of [
    `https://cloud.example.org/apps/phonetrack/publicSessionWatch/${TOKEN}?lineToggle=1`,
    `https://cloud.example.org/apps/phonetrack/publicWatch/${TOKEN}`,
  ]) {
    assert.deepEqual(parseToken(link), { error: 'unsupported' }, link);
    const config = normalizeConfig({ token: link });
    assert.equal(config.tokenUnsupported, true);
    assert.equal(config.token, '');
    assert.deepEqual(parseServerUrl(link), { error: 'link' }, 'never in the address field');
  }
  assert.equal(
    parseToken(`https://example.org/nc/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`)
      .linkServer.base,
    'https://example.org/nc',
  );
  assert.deepEqual(parseToken('https://cloud.example.org/apps/files/'), { error: 'invalid' });
});

test('normalizeConfig: defaults, the link alone, a mismatch, invalid values', () => {
  const plain = normalizeConfig({ url: 'cloud.example.org', token: TOKEN });
  assert.equal(plain.server.base, 'https://cloud.example.org');
  assert.equal(plain.token, TOKEN);
  assert.equal(plain.pollSeconds, 60);
  assert.equal(plain.silentMinutes, 60);
  assert.equal(plain.tokenInvalid, false);

  const link = `https://cloud.example.org/index.php/apps/phonetrack/api/getlastpositions/${TOKEN}`;
  const alone = normalizeConfig({ token: link });
  assert.equal(alone.server.base, 'https://cloud.example.org');
  assert.equal(alone.token, TOKEN);
  assert.equal(normalizeConfig({ url: 'https://cloud.example.org/', token: link }).urlError, null);
  assert.equal(
    normalizeConfig({ url: 'https://other.example.org', token: link }).urlError,
    'mismatch',
  );
  assert.equal(normalizeConfig({ token: link.replace('https:', 'http:') }).urlError, 'http');
  assert.equal(
    normalizeConfig({ url: 'https://cloud.example.org', token: link.replace('https:', 'http:') })
      .urlError,
    'http',
  );
  assert.equal(normalizeConfig({ token: TOKEN }).urlError, 'missing');
  assert.equal(normalizeConfig({ url: 'x.org', token: 'a b' }).tokenInvalid, true);
  assert.equal(normalizeConfig({ url: 'x.org', token: 'abc​def' }).tokenInvalid, true);
  assert.equal(normalizeConfig({ url: 'x.org', token: 'https://x.org/nope' }).tokenInvalid, true);
  assert.equal(normalizeConfig({ url: 'x.org', token: '' }).token, '');
  const odd = normalizeConfig({
    url: 'x.org',
    token: TOKEN,
    poll_interval: '7',
    silent_minutes: 'x',
    certificate_fingerprint: 'zz',
  });
  assert.equal(odd.pollSeconds, 60);
  assert.equal(odd.silentMinutes, 60);
  assert.equal(odd.fingerprintInvalid, true);
  const chosen = normalizeConfig({
    url: 'x.org',
    token: TOKEN,
    poll_interval: '300',
    silent_minutes: '15',
    certificate_fingerprint: 'ab'.repeat(32),
  });
  assert.equal(chosen.pollSeconds, 300);
  assert.equal(chosen.silentMinutes, 15);
  assert.equal(chosen.fingerprint, Array(32).fill('AB').join(':'));
  assert.equal(normalizeConfig(null).urlError, 'missing');
});
