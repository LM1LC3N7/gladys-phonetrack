# gladys-phonetrack

[Gladys Assistant](https://gladysassistant.com) external integration for
**PhoneTrack**, the location app of Nextcloud: each device of a public
PhoneTrack session becomes a Gladys device (latitude, longitude, battery,
accuracy, speed, altitude, bearing, satellites, last seen, silent), and a
device that stops reporting a scene trigger. Read only, pull only (works
behind a NAT).
**Unofficial integration, not affiliated with PhoneTrack nor Nextcloud.
Never tested with a real Nextcloud yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (PhonetrackApp)
                 ├─ src/phonetrack/client.js   GET api/getlastpositions/<token>
                 ├─ src/phonetrack/http.js     the only network access (node:https, fingerprint)
                 ├─ src/phonetrack/parse.js    answer -> plain objects (units, ranges)
                 ├─ src/phonetrack/errors.js   error codes, what a refusal is
                 ├─ src/budget.js              states per minute
                 ├─ src/store.js               /data: refusals, pauses (digests only)
                 └─ src/devices.js             devices (pure), never fewer features
```

- **Access**: the public token of a PhoneTrack session (its "API URL (JSON,
  last positions)"), part of the path of
  `GET <nextcloud>/index.php/apps/phonetrack/api/getlastpositions/<token>`.
  No URL is ever logged; errors carry codes, never addresses.
- **Refusals** (HTTP 401 / 403, or PhoneTrack's own 404 `{"error": "Session
not found"}`): Nextcloud counts each one as a brute-force attempt, so the
  integration stops 1 h, then 6 h, then 24 h (persisted in `/data` as a
  salted HMAC of the address and token, with the step and the end); saving
  the configuration makes one attempt at once. HTTP 429 and 5xx pause every
  request (Retry-After, 1 min to 6 h, never under the poll interval, kept in
  `/data`); other failures retry from the poll interval, doubling to 30 min.
- **TLS**: strict by default; a self-signed certificate is accepted only by
  a typed SHA-256 fingerprint, checked on the handshake before the request
  (and the token) is written. `http://` is refused.
- **Reading** (every 60 s by default): one request; 50 devices at most.
  External ids: `device:<digest of the token>-<digest of the device name>`
  (never the token). Every state within 250 states/min: silent, then the
  position (latitude with longitude), battery, other numbers, last seen.
- **Trigger** `device_silent`: per device and threshold (15 min to 24 h,
  required in the scene), once per silence; nothing for what is already
  silent at the first reading or for a new device.
- **Privacy**: no position, name, token or address in the logs or `/data`.
- **User position on the Gladys map**: not possible for an external
  integration today (no host API endpoint): see TODO.md for the core change
  to propose.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake PhoneTrack
(`test/helpers/fakePhonetrack.js`), plus loopback http / https servers for
the transport. No test touches a real Nextcloud or the Internet.

## Credits

- [PhoneTrack](https://github.com/julien-nc/phonetrack) (AGPL-3.0): only its
  HTTP API is called; no code of PhoneTrack is used (see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [guim31/gladys-nextcloud](https://github.com/guim31/gladys-nextcloud)
  (Apache-2.0): how Nextcloud's brute-force protection answers.
- [gladys-netbird](https://github.com/LM1LC3N7/gladys-netbird): the
  structure of the app, the retry policy and the certificate fingerprint.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
