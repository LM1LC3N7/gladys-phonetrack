# TODO — PhoneTrack v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own (Louis's rule: one message per wave in
  /t/10385). PhoneTrack was added on 2026-10-18 at Louis's request, outside
  the lot.

## Status

- [x] **Milestone 1 — MVP** (2026-10-18): pull of
      `GET <nextcloud>/index.php/apps/phonetrack/api/getlastpositions/<token>`
      with the public token of a session (or its whole "API URL (JSON, last
      positions)" pasted in the secret field); one device per PhoneTrack
      device (latitude, longitude, battery, accuracy, speed, altitude,
      bearing, satellites when sent, last seen, silent); trigger
      `device_silent` (threshold chosen in the scene, once per silence, not
      at the first reading); refusal ladder 1 h / 6 h / 24 h persisted;
      429 / 5xx pause bounded and persisted; status and Discovery sent again
      at every `connected`; never a smaller device; strict TLS or a pinned
      fingerprint; no position, name, token or address in logs or `/data`;
      docs en/fr. Tested with unit tests against the SDK's fake Gladys, a
      fake PhoneTrack (in memory and on loopback https) and loopback http /
      https servers. **Never tested with a real Nextcloud.** No Docker on
      this PC: no e2e test in a container.
- [x] **Review corrections** (2026-10-18, extra review of `e4f89f8`, 3
      important and 13 minor points): failures persisted whatever the
      generation, pending attempt, one forced attempt per series, bounded
      timestamps and isolated devices, internal / too-large messages,
      thresholds re-armed below 15 min only, clock jump and future points,
      created devices only, events marked once sent, cap keeps created
      devices, PHP list sessions, watch links refused, step wait on
      timeouts, read-back cap per step, configuration fallback, 403 text,
      docs; `test/timezone.test.js` (Lisbon, Helsinki). See "Decisions".
- [ ] **Milestone 2 — real Nextcloud** (a tester with PhoneTrack): record a
      real answer as a fixture (token and positions removed), fix what
      differs. To check first:
  - the exact answer of `getlastpositions` (keyed by the token? numbers as
    floats? `[]` for a session without points?), and of a session made
    private again (404 `{"error": "Session not found"}` as read in the
    controller?);
  - Nextcloud's brute-force protection on that route
    (`#[BruteForceProtection(action: 'PhonetrackAPIGetLastPositionsPublic')]`):
    how long the answers are slowed down after a refusal, when it answers
    429, whether the 45 s timeout is enough;
  - pretty URLs: `/index.php/apps/...` always works? (`/apps/...` is used by
    the links PhoneTrack shows);
  - the speed of each logger (PhoneTrack Android, GpsLogger, uLogger...):
    m/s as PhoneTrack's pages assume? Open question for OwnTracks: its
    `vel` is km/h, but PhoneTrack's `logOwntracks` stores no speed at all
    (read in the source): to confirm on a real server, nothing said in the
    docs meanwhile;
  - `timestamp` of a point: the clock of the phone (a phone with a wrong
    clock looks silent or not);
  - the batch upload of old points (a phone offline for hours).
- [ ] **Milestone 3 — the position of a Gladys user** (needs a change of the
      Gladys core, then Louis's agreement): see "Core PR to propose" below.
      Then: an option per device "Gladys user to move" (a `users` source),
      off by default.
- [ ] **v2** (brief of Louis, not now):
  - geofences of PhoneTrack in push (its geofence URL calls a webhook of
    the integration: `webhooks` capability), presence per zone;
  - proximity between two devices (PhoneTrack's proximity alerts, or
    computed);
  - history / GPX export (`api/getpositions/<token>?limit=`);
  - a "today's track" widget: needs a change of the core (a map widget)
    and Louis's agreement;
  - several sessions / several Nextcloud instances;
  - privacy: a "zone only" option that publishes the zone (or home / away)
    and never the exact position;
  - the filtered public shares of PhoneTrack ("Share link", which can be
    restricted to one device and to its last position: the most private
    access): they are refused by `getlastpositions` and served by
    `getpositions/<sharetoken>?limit=1`;
  - a trigger "device reports again" if users ask.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published.

## Core PR to propose (not opened)

An external integration **cannot** publish the position of a Gladys user
today (checked on Gladys `0027571e`, 2026-10-16, and SDK 0.15.0):

- the SDK has no method for it (`getHouses()` reads the houses only, behind
  `location: true`); nothing about users, OwnTracks or locations;
- the host API (`/api/integration/v1/*` in `server/api/routes.js`) has no
  user or location route; `post /api/v1/user/:user_selector/location`
  exists but takes a user session (`authenticated: true`), not the token of
  an integration; OwnTracks reaches `location.create` only through the
  Gladys Plus gateway (`location.handleNewGatewayOwntracksLocation.js`).

The minimal change, to propose to the core (not opened, Louis decides):

1. `server/api/routes.js`: `'post /api/integration/v1/user/:user_selector/location'`
   with `authenticated: false, externalIntegrationAuth: true`, controller
   `integrationHostController.publishUserLocation`.
2. `server/api/controllers/integrationHost.controller.js`: the controller,
   body `{ latitude, longitude, accuracy?, altitude?, created_at? }`
   (validated: ranges, numbers), calls a new
   `server/lib/external-integration/externalIntegration.publishUserLocation.js`
   that checks a manifest declaration (`user_location: true`, shown on the
   install screen, 403 otherwise, like `location` for the houses), checks
   that the user chose this integration for their position (consent per
   user, e.g. a `users` dynamic source in `DYNAMIC_SOURCES` of
   `server/lib/external-integration/constants.js` so a device can name its
   user), then calls `gladys.location.create(userSelector, location)` (which
   already updates the user, emits `user.new-location` for the areas and the
   websocket event of the map).
3. `validateManifest.js` and `docs/specs/external-integrations/contracts/host-api-endpoints.md`,
   `manifest.md`: the new field and route; tests next to the house ones.
4. SDK: `gladys.publishUserLocation(userSelector, { latitude, longitude, accuracy, altitude })`,
   and the `users` source in the fake Gladys.

## Decisions

- **Duplicate check**: done by the main session before the brief (Louis's
  request of 2026-10-18); not repeated here.
- **Reuse**: no library: one GET and a small JSON answer. PhoneTrack
  (AGPL-3.0) is never copied: its routes, controller and docs were only
  read to know the API (`THIRD_PARTY_NOTICES.md`). guim31/gladys-nextcloud
  (Apache-2.0) for Nextcloud's brute-force behaviour, no code copied; the
  structure comes from LM1LC3N7/gladys-netbird (approved). The standard
  Apache-2.0 `LICENSE` (copy of gladys-tedee's, no personal name) and the
  notices are copied into the image.
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-phonetrack:0.1.0`); the first patch release gives
  0.1.1.
- **Endpoint**: `api/getlastpositions/<token>` (brief), the "API URL (JSON,
  last positions)" PhoneTrack shows when the session is public; always
  through `/index.php/` (works with and without pretty URLs). It only
  accepts the public token of a session (`publicviewtoken`, `public=1`): a
  filtered "Share link" token gets 404 (v2 note). The per-device route
  (`getlastpositions/<token>/<device>`) is not used: one request reads
  them all. `api/getuserlastpositions` (with Nextcloud credentials) is not
  used: the brief asks for a read-only share, nothing more.
- **User position: not possible** (see "Core PR to propose"): no option
  per device, nothing worked around; the docs say the Gladys map and zones
  do not react to PhoneTrack yet.
- **Token field**: a `secret` field (kept in clear in the Gladys database,
  masked in the UI, never shown again: never written "encrypted"). It takes
  the token or a whole API link (`api/getlastpositions/<token>` or
  `api/getpositions/<token>`); from a link, only the token and the
  Nextcloud address are kept. A watch page link (`publicSessionWatch`,
  `publicWatch`: public session or filtered share) is refused with
  "filtered share not supported", before any request (review point 10:
  a filtered share token would get a 404, counted as a brute-force
  attempt). A link typed in the address
  field (shown in clear) is refused; a link pointing to another server than
  the typed address is refused (the token never goes elsewhere). The token
  must match `[A-Za-z0-9_-]{6,128}`.
- **Never a URL in a log**: the token is part of the path. The transport's
  errors carry codes only (no Node message, which may quote the host); the
  logs say "the configured PhoneTrack session".
- **External ids**: `device:<s>-<d>` with `s` = 10 hex of
  SHA-256(`gladys-phonetrack:session:<token>`) and `d` = 16 hex of
  SHA-256(`gladys-phonetrack:device:<name>`) (brief: session + device name,
  stable; the token itself never appears in Gladys). Renaming a device in
  PhoneTrack makes a new device (documented). Feature keys: `latitude`,
  `longitude`, `battery`, `accuracy`, `speed`, `altitude`, `bearing`,
  `satellites`, `last_seen`, `silent`.
- **Feature types** (core constants of 2026-10-16; units only those of
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`): latitude / longitude
  `unknown`/`unknown` without unit (the core has no coordinates category;
  `degree` is listed for no category), min/max ±90 / ±180; battery
  `battery`/`integer` `percent`; accuracy and altitude
  `distance-sensor`/`decimal` `m`; speed `speed-sensor`/`decimal`
  `kilometer-per-hour` (PhoneTrack stores m/s: ×3.6, one decimal); bearing
  `angle-sensor`/`integer` without unit (the category takes none), 0-359;
  satellites `counter-sensor`/`integer`; last seen `text`/`text`
  (`YYYY-MM-DD HH:MM UTC`, the time zone of Gladys is unknown); silent
  `unknown`/`binary` read only (never a switch: lesson of lot 6). All read
  only. History: battery and silent kept; positions and the other values
  not by default (privacy; the user can turn it on).
- **Satellites only when sent**: the feature is in the Discovery blueprint
  once a reading carried satellites for that device (memory) or when the
  created device has it; a state is published only for a feature the
  created device has (no state for a feature missing until "Update").
- **Silent**: from the timestamp of the last point (phone clock) and the
  clock of Gladys; a point "from the future" counts as 0 min. The feature
  uses the configured delay (`silent_minutes`, 1 h by default).
  Timestamps are bounded (0 < s < 1e11 seconds, else no date) and
  `formatDate` returns null for an impossible date; each device is parsed
  and processed alone (an unreadable one is skipped, the others go on).
- **Trigger `device_silent`**: the core matches fields by equality only
  (spec scene-triggers §4.2: no threshold), so the delay is a **required**
  select field `minutes` (same 8 values as the configuration, sent as a
  string): the integration fires one event per threshold reached, once per
  silence. Review corrections:
  - only devices created in Gladys fire (keys of `gladys.devices`); the
    others only record what they reach (creating one later fires nothing
    for a delay already reached);
  - the thresholds reached are cleared only when the age falls under the
    smallest one (15 min): a late batch of old points (age 100 min after
    120 fired) never fires 120 again;
  - a threshold is marked reached only once its event left (a failed
    publication is retried); beyond 30 events per reading, the rest waits
    for the next reading;
  - "not at the first reading": a device seen for the first time (start of
    the integration, a new device) only records what is already reached; a
    point more than 5 min in the future (clock of Gladys late at start) is
    no baseline; a jump of the wall clock between two readings (Date.now
    against performance.now, more than 5 min apart) makes that reading a
    new baseline (no event). The state budget runs on performance.now.
    The memory is kept in RAM across a reconnection to Gladys (same server and
    session), never in `/data`; a restart of the container starts over. After
    an outage of Nextcloud, a threshold crossed meanwhile fires at the first
    reading that works (late, once). Data: `device` (external id), `minutes`,
    `device_name`, `silent_for` (minutes), `last_seen`; never a position.
- **Cap of 50 devices**: the devices created in Gladys first, then the
  others by name (review point 8). A session that PHP encodes as a list
  (keys 0..n-1) is read, the indexes being the names.
- **Refusals** (brief: "1 h, 6 h, 24 h, never a loop"): HTTP 401, 403 (any
  body: Nextcloud, an authentication in front of it, or a firewall / proxy
  blocking Gladys: kept as a refusal, the status names that cause), and 404
  when the body is PhoneTrack's JSON `{ "error": ... }` (session not public,
  share deleted, wrong token). A 404 page that is not PhoneTrack's (wrong
  folder, app disabled) is not a refusal: retried like an unexpected
  answer. Step 1 → 1 h, 2 → 6 h, then 24 h for every refusal after;
  persisted in `/data` as JSON `{ k: HMAC of address and token, s: step,
u: end, p: pending, f: forced }` under a salted digest of the address.
  - **Never lost** (review point 1): the context (server key, HMAC, step,
    interval) is captured when the request is sent and travels with its
    failure; the refusal or the pause is written to `/data` as soon as the
    answer arrives, before the badges, whatever the generation (Gladys
    disconnected, a new configuration started); only the rescheduling is
    skipped for an older generation. A success likewise clears them.
  - **Pending attempt**: before an attempt within a series of refusals,
    `p: true` is written; a start that finds it counts one more refusal.
  - **Within a series of refusals** any other failure (timeout, network,
    429 / 5xx) waits for the end of the current step again (max with the
    pause): never a faster retry (review point 11).
  - **Read back**: the end is capped by the delay of its own step
    (now + 1 h / 6 h / 24 h), written back (review point 12).
  - **Saving the configuration** (Louis's decision, option b): one forced
    attempt per series of refusals, flag `f` persisted, cleared only by a
    reading that works or a change of key (another token or address is
    tried at once, the old entry dropped). After it, saving says "already
    tried again, next attempt in X". Restarts, reconnections and the test
    button always wait.
    A reading that works forgets the refusal.
- **Pauses**: HTTP 429 pauses every path for its Retry-After, bounded
  max(1 min, poll interval) to 6 h; 5xx pauses for the back-off delay (or a
  longer Retry-After, up to 6 h). Persisted in `/data`, capped when read
  back (the capped end written back), removed after a reading that works.
  Saving the configuration does not lift a pause. Other failures retry from
  max(1 min, poll interval), doubling up to 30 min; never a dead
  integration. An error is never read again faster than the interval, a
  reconnection to Gladys included (retry wait kept in memory).
- **Timeout 45 s, test button 60 s** (budget 55 s): Nextcloud slows the
  answers of a suspected address (up to 25 s) before it refuses them.
- **Messages**: a failure that is not a `PhonetrackError` (a fault of the
  integration) says "internal error" and is logged as an error, never
  "Nextcloud does not answer"; an answer above 2 MB says "too large".
- **Reconnection to Gladys** (`connected`): the app restarts; the status and
  Discovery are sent again (`lastStatus`, `discoveredKey`, published values
  and badges cleared); refusals and pauses come from `/data`; during a stop
  or a pause, Discovery is republished from the devices last read (memory).
  If `GET /config` fails, the last configuration the SDK received
  (`gladys.config`) is used; without any, the status says so and a timer
  reads it again every minute (never without status nor timer).
- **Time zones**: every date is UTC; `test/timezone.test.js` runs
  `test/app.test.js` again in child processes with TZ=Europe/Lisbon and
  TZ=Europe/Helsinki.
- **Never a smaller device**: the published device keeps every feature of
  the created one in `gladys.devices` (lesson of lot 6).
- **TLS**: strict by default; a typed SHA-256 fingerprint must match
  exactly, decided on the handshake before the request (whose path holds
  the token). No trust on first use. `http://` refused outright (the token
  would cross the network in clear), even on a LAN.
- **Privacy**: no position, device name, token or address in a log or in
  `/data` (the server is keyed there by a salted digest of its address).
  The user agent of the logger is never read into Gladys. Positions rounded
  to 6 decimals.
- **Rate of states**: POST /state admits 300 states/min; the integration
  keeps a sliding window under 250 for every state, by priority: silent,
  position (latitude and longitude never split), battery, other numbers,
  last seen; a cut group takes turns. 50 devices at most (the rest counted
  in the status). Badges in calls of 100. One reading at a time.
- **Poll interval**: 60 s by default (brief), 30 / 120 / 300 / 600 offered.
- **Transport badge**: `cloud` when PhoneTrack answers and the device is in
  the reading, `unreachable` otherwise. `transports: ["cloud"]` in the
  manifest (the phones report through the Internet).
- `gladys_version >=5.1.0` (scene triggers). Category `services`. No
  `location: true`: the houses of Gladys are never read.
