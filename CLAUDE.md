# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for PhoneTrack (the location app
of Nextcloud): a Node.js service (Node 22+, ESM, no build step) that runs in
its own sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the last positions of the devices of
one public PhoneTrack session through its read-only API link. Read only,
pull only. See `TODO.md` for the status and every decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every SDK handler, registered before connect()
src/app.js                        PhonetrackApp: start queue, loop, failures, states, trigger
src/phonetrack/client.js          GET api/getlastpositions/<token>
src/phonetrack/http.js            the only network access (node:https, fingerprint pin)
src/phonetrack/parse.js           answer -> plain objects (no user agent kept)
src/phonetrack/errors.js          error codes; what a refusal is
src/devices.js                    devices (pure), external ids, never fewer features
src/config.js                     DEFAULTS (mirror the manifest) + normalization
src/store.js                      /data: refusals, pauses, salt (digests only)
src/budget.js                     sliding window of the states sent per minute
src/i18n.js                       statuses and messages (en / fr)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys (SDK) + fake PhoneTrack
```

## Rules

- **External ids are forever**: `device:<session digest>-<device digest>`
  and the feature keys of `src/constants.js`. Changing the digest recipe
  creates new devices and orphans the old ones. The same goes for every key
  users store: manifest `config_schema`, `actions`, the scene trigger key,
  its fields and their option values.
- **Read only**: no request other than the GET of the last positions, no
  command. Adding one needs Louis's decision, off by default, never a switch.
- **The token is part of the URL**: never log a URL, never put one in an
  error message, never write the token, an address, a position or a device
  name to `/data` or a log.
- **Refusals** (401 / 403 / PhoneTrack's 404) count as brute-force attempts
  for Nextcloud: the stop ladder (1 h, 6 h, 24 h) must never become a loop.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, before the first release).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects; the catalog
  `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **Encoding.** Files are UTF-8 without BOM; `test/encoding.test.js` refuses
  mojibake in the manifest, docs, README, CHANGELOG, TODO, CLAUDE.md, the
  notices and `src/**/*.js`. Write files with an editor, never through a
  shell that guesses a code page.
- **PhoneTrack is AGPL-3.0**: never copy its code; only its HTTP API is used.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
