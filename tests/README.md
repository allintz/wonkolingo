# Tests

Everything except `smoke.mjs` and `live-smoke.mjs` runs against a LOCAL `wrangler dev`, never production, because the tests create accounts, groups and courses. The browser tests use the Google Chrome already on this Mac through `playwright-core` (no browser download; set `CHROME=/path/to/chrome` if it lives elsewhere).

Two local servers, each with its own database:

```
wrangler d1 execute DB --local --file schema.sql
wrangler dev --local --port 8799 --ip 127.0.0.1 --compatibility-date 2026-04-17
# email tests: a second server in email test mode (codes come back in the response instead of being sent)
wrangler d1 execute DB --local --persist-to .wrangler/email --file schema.sql
wrangler dev --local --port 8791 --ip 127.0.0.1 --compatibility-date 2026-04-17 --persist-to .wrangler/email --var EMAIL_TEST_MODE:1
```

Google and Apple sign-in tests need a server that trusts the test key in `tests/idp-test-key.json` (localhost only):

```
wrangler dev --local --port 8795 --ip 127.0.0.1 --compatibility-date 2026-04-17 --persist-to .wrangler/g --var "GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com" --var "GOOGLE_IOS_CLIENT_ID:test-ios.apps.googleusercontent.com" --var "IDP_TEST_JWKS:$(node -e "console.log(JSON.stringify(require('./tests/idp-test-key.json').jwks))")"
```

(The pinned wrangler's local runtime only supports compatibility dates up to 2026-04-17; the override is local-only. Email test mode only works on localhost.)

| File | What it checks | Run |
|---|---|---|
| `unit.test.mjs` | streak rules (including schedule history) and course validation | `node tests/unit.test.mjs` |
| `api.test.mjs` | 72 API checks: groups, auth, isolation, sync, courses, reports, size limits, CORS | `node tests/api.test.mjs http://127.0.0.1:8799` |
| `accounts.test.mjs` | 98 checks: accounts without a group, joining and leaving, sign-in codes, rate limits, passkeys (software authenticator from node's crypto, at origin `http://localhost:8799`), passwords, sign out other devices | `node tests/accounts.test.mjs http://127.0.0.1:8799` |
| `security.test.mjs` | 40 checks, one or more per 10/21 red-team finding: bad dates can't break the board, huge schedules can't slow it, shared account caps (IPv6 /64 too), rate limits under parallel requests, one-use codes, feed text, XP cap, CORS, names, state shape, course deletion, blocked reports | `node tests/security.test.mjs http://127.0.0.1:8799` |
| `email.test.mjs` | 23 checks: adding and confirming an email, one address per account, code tries, signing in by email, setting a new password after, limits, deletion | `node tests/email.test.mjs http://127.0.0.1:8791` |
| `e2e.test.mjs` | ~420 browser checks in headless Chrome at phone and desktop size: cold start on every route, sign-up and sign-in, a full session, every card in every course rendered and answered in every answer style, saved states of every shape, phone layout, offline and slow networks, groups, Me settings, the 10/21 client fixes, and (on the 8791 server) the email screens. `ONLY=name1,name2` runs some tests. | `node tests/e2e.test.mjs http://localhost:8799` and `ONLY=email node tests/e2e.test.mjs http://localhost:8791` |
| `idp.test.mjs` | ~28 checks: Google (web and iOS clients) and Apple sign-in make, find and connect accounts; bad tokens (audience, expiry, issuer, key, tampering, alg none, wrong provider) are refused; deletion frees the account | `node tests/idp.test.mjs http://127.0.0.1:8795` (sign-in test server) |
| `smoke.mjs` | the built page starts cleanly on every route with the network cut off; `deploy.sh` runs it before deploying | `node tests/smoke.mjs` |
| `live-smoke.mjs` | read-only check of the live site after a deploy; `deploy.sh` runs it | `node tests/live-smoke.mjs` |
| `social.test.mjs` | ~41 checks: friend streaks (request, accept, decline, end, limit of 5 counting active and sent requests, leaving or blocking ends them), nudges and their emails, high-fives only for real feed items, notifications, deletion | `node tests/social.test.mjs http://127.0.0.1:8791` (email test mode server) |
| `runthrough.test.mjs` | ~114 browser checks playing real rounds as several players over simulated days: day one, next day (clock moved forward), 7-day milestone, a freeze saving a streak, free earn-back (also after quitting mid-round), buying freezes and seeing them on a second device, daily goal, the whole friend-streak flow, limits, nudges with email, notifications, high-fives, the phone reminder text, far-apart time zones, sync merging and reset. Sounds are recorded instead of played. | `node tests/runthrough.test.mjs http://localhost:8791` (email test mode server) |
| `push.test.mjs` | ~22 checks of iPhone push: registering phones, signed APNs requests (checked against the test key), nudge, high-five, friend-streak request/accept and "your turn" pushes, the off switch, the 8-a-day cap, dead tokens forgotten, sign-out and deletion. Runs its own fake APNs on 127.0.0.1:8841. | Start a server with `--var APNS_HOST:http://127.0.0.1:8841 --var APNS_KEY_ID:TESTKEY123 --var "APNS_KEY:$(node -e "console.log(require('./tests/push-test-key.json').pkcs8)")"`, then `node tests/push.test.mjs http://127.0.0.1:<port>` |

## Shared cards and compatible phone updates (2026-10-23)

`node scripts/lint_shared.mjs` validates the current built-in identity graph in `docs/content-v2.json`. `node tests/tidy.test.mjs` checks shared learning history, v2 migration, removals/restores, skips, familiarity checklists, glossary terms and direct lessons in local Chrome. Both run before deployment. The main browser suite includes the same assertions as `ONLY=tidy`.

The page and new iPhone bundles fetch `/content-v2.json`. Keep the existing `/content.json` unchanged for older installed apps: they cannot interpret list-based duplicate links or the retired Toolkit draft. A physical phone needs the updated native bundle before receiving this app behavior. `WONKOLINGO_SOURCE` optionally points build.sh at a staging page for isolated testing.

## Course catalog (2026-10-23)

`node tests/catalog.test.mjs` checks categories, category/level filters, title search, the suggested path, previews, sample questions without progress changes, editable upload suggestions, and category metadata in downloaded content. It exercises 320px and 390px phone layouts, desktop, and dark mode. `ONLY=catalog` runs the corresponding checks in the main browser suite. Course category round trips are covered by `api.test.mjs`. The catalog suite is also part of the deployment gate.

## Native widget stills (2026-10-23)

`ONLY=widget node tests/e2e.test.mjs http://localhost:8807` checks the app-to-widget snapshot, uncapped XP, future days, reviews and freeze consumption on a local server. The full browser suite includes these checks. Native selection and old-payload compatibility can be checked with `cat ios/App/Shared/WidgetStore.swift tests/widget-store.test.swift > /tmp/wonko-widget-main.swift && swift /tmp/wonko-widget-main.swift`. The seven approved original-style PNGs are bundled under `ios/App/WonkoWidget/Artwork/`; the widget decodes 512px thumbnails at runtime to keep memory bounded.

## Friends (2026-10-23)

`FRIENDS_TEST_DB=.wrangler/friends-v1 node tests/friends.test.mjs http://127.0.0.1:8817` checks account-to-account username search, private email sign-ins, separate friendship and streak consent, mute/block/removal, course share links, reward concurrency, 7/30/100-day milestones, restart farming and migration of accepted legacy streak partners without adding all group members. Use a local server initialized from schema.sql with the same persist-to path. The date fixtures edit only that isolated local database. `ONLY=groups,retention,fixes` in the main browser suite checks the Friends screens. The broader run-through suite keeps legacy group API fixtures for older-app compatibility and explicitly connects friends.

Deploy the additive migration `migrations/2026-10-23-friends.sql` before the Worker. Existing course group codes, player ids, review progress and streak rows stay in place. Old app versions can continue using the group API. New uploads use a personal library, with explicit share links. Weekly reward and badge claims are durable and unique per pair, recipient and numbered milestone. High fives stay in-app; request/streak push preferences and optional milestone pushes are under Friends.
