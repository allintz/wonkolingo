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

Google sign-in tests need a server that trusts the test key in `tests/google-test-key.json` (localhost only):

```
wrangler dev --local --port 8795 --ip 127.0.0.1 --compatibility-date 2026-04-17 --persist-to .wrangler/g --var "GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com" --var "GOOGLE_TEST_JWKS:$(node -e "console.log(JSON.stringify(require('./tests/google-test-key.json').jwks))")"
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
| `google.test.mjs` | 19 checks: Google sign-in makes, finds and connects accounts; bad tokens (audience, expiry, issuer, key, tampering, alg none) are refused; deletion frees the Google account | `node tests/google.test.mjs http://127.0.0.1:8795` (Google test server) |
| `smoke.mjs` | the built page starts cleanly on every route with the network cut off; `deploy.sh` runs it before deploying | `node tests/smoke.mjs` |
| `live-smoke.mjs` | read-only check of the live site after a deploy; `deploy.sh` runs it | `node tests/live-smoke.mjs` |
