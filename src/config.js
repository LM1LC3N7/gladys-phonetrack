// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { POLL_INTERVALS, SILENT_MINUTES } from './constants.js';
import { normalizeFingerprint } from './phonetrack/http.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  poll_interval: '60',
  silent_minutes: '60',
});

/** What PhoneTrack gives as a public token: letters, digits, `-` and `_`. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

/** The links of PhoneTrack that carry the public token of a session. */
const LINK_PATTERN =
  /\/apps\/phonetrack\/(?:api\/getlastpositions|api\/getpositions|publicSessionWatch)\/([^/?#]+)/i;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The Nextcloud server: `https://host[:port][/path]` (a bare `host[:port]` is
 * read as https). What follows the Nextcloud address in a link of PhoneTrack
 * (`/index.php`, `/apps/phonetrack/...`) is dropped. http:// is refused (the
 * share token is part of the URL and would cross the network in clear), and
 * so are credentials, a query and a fragment.
 *   -> { base, hostname, port } or { error: 'missing' | 'invalid' | 'http' | 'credentials' | 'link' }
 */
export function parseServerUrl(value) {
  const raw = text(value);
  if (!raw) return { error: 'missing' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const full = hasScheme ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(full);
  } catch {
    return { error: 'invalid' };
  }
  // A link with the token typed in this field (shown in clear): refused.
  if (LINK_PATTERN.test(url.pathname)) return { error: 'link' };
  if (url.protocol === 'http:') return { error: 'http' };
  if (url.protocol !== 'https:') return { error: 'invalid' };
  if (url.username || url.password) return { error: 'credentials' };
  if (url.search || url.hash || !url.hostname) return { error: 'invalid' };
  const path = url.pathname
    .replace(/\/apps\/phonetrack(\/.*)?$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/index\.php$/i, '')
    .replace(/\/+$/, '');
  if (path && !/^(\/[A-Za-z0-9._~%-]+)+$/.test(path)) return { error: 'invalid' };
  // `https://host:443` loses its port in URL (the default): read it from the text.
  const typedPort = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]*\]|[^/:?#]*):(\d+)/i.exec(full);
  const port = typedPort ? Number(typedPort[1]) : 443;
  if (!(port > 0 && port < 65536)) return { error: 'invalid' };
  const hostname = url.hostname.toLowerCase();
  const origin = port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`;
  return { base: `${origin}${path}`, hostname, port };
}

/**
 * The token field: the public token of the session, or a link of PhoneTrack
 * that carries it (the "API link" of the session's public sharing, or its
 * public watch link). -> { token, linkServer } | { error: 'invalid' }; with a
 * link, `linkServer` is the Nextcloud address it points to (parseServerUrl).
 */
export function parseToken(value) {
  const raw = text(value);
  if (!raw) return { token: '', linkServer: null };
  if (!raw.includes('/')) return { token: raw, linkServer: null };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  const match = LINK_PATTERN.exec(url.pathname);
  if (!match) return { error: 'invalid' };
  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return { error: 'invalid' };
  }
  // The address of the link, without the token part (never kept with it).
  const at = url.pathname.toLowerCase().indexOf('/apps/phonetrack/');
  const prefix = `${url.protocol}//${url.host}${url.pathname.slice(0, at)}`;
  return { token, linkServer: parseServerUrl(prefix) };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const pick = (key, list) => (list.includes(String(raw[key])) ? String(raw[key]) : DEFAULTS[key]);
  const typedFingerprint = text(raw.certificate_fingerprint);
  const fingerprint = typedFingerprint ? normalizeFingerprint(typedFingerprint) : null;
  const parsedToken = parseToken(raw.token);
  const token = parsedToken.error ? '' : parsedToken.token;
  let server = parseServerUrl(raw.url);
  let urlError = server.error ?? null;
  const link = parsedToken.linkServer;
  if (urlError === 'missing' && link) {
    // Only the link was given: its address is the server.
    server = link;
    urlError = link.error ?? null;
  } else if (!urlError && link && (link.error || link.base !== server.base)) {
    // The link points elsewhere: the token is never sent to another server.
    urlError = link.error === 'http' ? 'http' : 'mismatch';
  }
  return {
    server: urlError ? null : server,
    urlError,
    token,
    tokenInvalid: Boolean(parsedToken.error) || (token !== '' && !TOKEN_PATTERN.test(token)),
    fingerprint,
    fingerprintInvalid: typedFingerprint !== '' && fingerprint === null,
    pollSeconds: Number(pick('poll_interval', POLL_INTERVALS)),
    silentMinutes: Number(pick('silent_minutes', SILENT_MINUTES)),
  };
}
