// Account tests against a local `wrangler dev`: accounts without a group, moving into and out of groups,
// sign-in codes, rate limits, and passkeys (a software authenticator built from node's crypto).
// Run: node tests/accounts.test.mjs http://127.0.0.1:8799
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const ORIGIN = 'http://localhost:8799', RP_ID = 'localhost';
// Each run looks like a new network, so the per-IP limits don't carry over between runs.
const IP = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };
async function call(path, { body, token, headers = {}, ip = IP } = {}) {
  const h = { 'CF-Connecting-IP': ip, Origin: ORIGIN, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: body !== undefined ? 'POST' : 'GET', headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
const today = new Date().toISOString().slice(0, 10);

// ---- minimal CBOR and a software passkey
const b64u = buf => Buffer.from(buf).toString('base64url');
const sha = b => createHash('sha256').update(b).digest();
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
function makeAuthenticator(origin = ORIGIN, rpId = RP_ID) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  let counter = 0;
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    credId,
    create(opts) {
      const cd = clientData('webauthn.create', opts.challenge);
      const authData = Buffer.concat([sha(rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: ['internal'] } };
    },
    get(opts, { key = privateKey, id = credId } = {}) {
      const cd = clientData('webauthn.get', opts.challenge);
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha(rpId), Buffer.from([0x05]), cnt]);
      const sig = sign('sha256', Buffer.concat([authData, sha(cd)]), key);
      return { id: b64u(id), rawId: b64u(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: undefined } };
    }
  };
}

// ---- an account with no group
let r = await call('/api/account', { body: {} });
ok(r.s === 200 && r.d.token && r.d.player.name === 'Player' && r.d.group === null, 'new account without a group', r);
const S = r.d;
r = await call('/api/account', { body: { name: '  Dana <b>Q</b>  ' } }); ok(r.s === 200 && r.d.player.name === 'Dana bQ/b', 'new account with a display name (cleaned)', r.d);
r = await call('/api/me', { token: r.d.token }); ok(r.d.player.name === 'Dana bQ/b', 'me returns the sign-up name', r.d);
r = await call('/api/me', { token: S.token }); ok(r.s === 200 && r.d.group === null && r.d.code === null && r.d.passkeys === 0 && r.d.player.id === S.player.id, 'me: no group', r.d);
r = await call('/api/state', { token: S.token, body: { state: { srs: { 'au0l0#0': { reps: 1 } }, activeDays: [today] } } }); ok(r.s === 200, 'solo player saves progress', r);
r = await call('/api/state', { token: S.token }); ok(r.d.state && r.d.state.srs['au0l0#0'], 'solo player loads progress', r.d);
r = await call('/api/complete', { token: S.token, body: { lessonId: 'au0l0', title: 'Solo lesson', xp: 30, acc: 90, day: today } }); ok(r.s === 200, 'solo player posts a lesson', r);
r = await call('/api/board', { token: S.token }); ok(r.s === 200 && r.d.players.length === 1, 'solo board is just the player', r.d);
r = await call('/api/courses', { token: S.token }); ok(r.s === 200 && r.d.courses.length === 0, 'solo player sees no group courses', r.d);

// ---- moving into a group keeps the account
r = await call('/api/groups', { body: { groupName: 'Acct Testers', name: 'Alice' } }); const A = r.d, code = A.code;
r = await call('/api/join', { token: S.token, body: { code, name: 'alice' } }); ok(r.s === 409, 'join: name taken by someone else -> 409', r);
r = await call('/api/join', { token: S.token, body: { code, name: 'Sam' } });
ok(r.s === 200 && !r.d.token && r.d.player.id === S.player.id && r.d.player.name === 'Sam', 'signed-in join moves the account, no new token', r.d);
r = await call('/api/me', { token: S.token }); ok(r.d.group && r.d.group.code === code && r.d.player.name === 'Sam', 'me shows the group', r.d);
r = await call('/api/state', { token: S.token }); ok(r.d.state && r.d.state.srs['au0l0#0'], 'progress survives joining', r.d);
r = await call('/api/board?today=' + today, { token: A.token });
const sam = r.d.players.find(p => p.id === S.player.id);
ok(sam && sam.total === 30, 'lessons from before joining count on the group board', r.d.players);
r = await call('/api/join', { token: S.token, body: { code, name: 'Sam' } }); ok(r.s === 200, 'rejoining your own group with your own name is fine', r);

// ---- leaving keeps the account
r = await call('/api/leave', { token: S.token, body: {} }); ok(r.s === 200, 'leave group', r);
r = await call('/api/me', { token: S.token }); ok(r.s === 200 && r.d.group === null, 'after leaving: no group, still signed in', r.d);
r = await call('/api/board', { token: A.token }); ok(!r.d.players.some(p => p.id === S.player.id), 'left player is off the group board', r.d.players);
r = await call('/api/state', { token: S.token }); ok(r.d.state && r.d.state.srs['au0l0#0'], 'progress survives leaving', r.d);
r = await call('/api/leave', { token: S.token, body: {} }); ok(r.s === 200, 'leaving with no group is a no-op', r);
r = await call('/api/groups', { token: S.token, body: { groupName: 'Sam’s group', name: 'Sam' } });
ok(r.s === 200 && !r.d.token && r.d.player.id === S.player.id, 'signed-in player starts a group with the same account', r.d);
r = await call('/api/me', { token: S.token }); ok(r.d.group && r.d.group.code === r.d.code && r.d.groupName === 'Sam’s group', 'me shows the new group', r.d);

// ---- sign-in codes
r = await call('/api/link', { body: {} }); ok(r.s === 401, 'link code needs sign-in', r);
r = await call('/api/link', { token: S.token, body: {} }); ok(r.s === 200 && /^[A-Z0-9]{8}$/.test(r.d.code) && r.d.expires > Date.now(), 'get a sign-in code', r.d);
const lc = r.d.code;
r = await call('/api/link/claim', { body: { code: lc.toLowerCase().slice(0, 4) + '-' + lc.slice(4).toLowerCase() } });
ok(r.s === 200 && r.d.token && r.d.token !== S.token && r.d.player.id === S.player.id && r.d.group, 'claim code (lowercase, with dash) signs in the same account', r.d);
const T2 = r.d.token;
r = await call('/api/me', { token: T2 }); ok(r.s === 200 && r.d.player.id === S.player.id, 'second device token works', r.d);
r = await call('/api/me', { token: S.token }); ok(r.s === 200, 'first device token still works', r.s);
r = await call('/api/link/claim', { body: { code: lc } }); ok(r.s === 404, 'a code works only once', r);
r = await call('/api/link/claim', { body: { code: 'ZZZZZZZZ' } }); ok(r.s === 404, 'unknown code -> 404', r);
r = await call('/api/me', { token: S.player.id + '.' + 'x'.repeat(24) }); ok(r.s === 401, 'wrong secret still rejected', r.s);

// ---- rate limits
const ip2 = '10.250.' + randomBytes(1)[0] + '.' + randomBytes(1)[0];
let last = 0;
for (let i = 0; i < 11; i++) last = (await call('/api/link/claim', { body: { code: 'ABCDEFGH' }, ip: ip2 })).s;
ok(last === 429, 'code guessing is rate-limited per network', last);
const ip3 = '10.251.' + randomBytes(1)[0] + '.' + randomBytes(1)[0];
for (let i = 0; i < 21; i++) last = (await call('/api/account', { body: {}, ip: ip3 })).s;
ok(last === 429, 'new accounts are rate-limited per network', last);

// ---- passkeys
const auth = makeAuthenticator();
r = await call('/api/passkey/register-options', { token: S.token, body: {}, headers: { Origin: 'https://evil.example' } }); ok(r.s === 400, 'passkey: unknown origin refused', r);
r = await call('/api/passkey/register-options', { body: {} }); ok(r.s === 401, 'passkey register needs sign-in', r);
r = await call('/api/passkey/register-options', { token: S.token, body: {} });
ok(r.s === 200 && r.d.options.rp.id === RP_ID && r.d.options.challenge && r.d.challengeId, 'passkey register options', r.d);
let reg = r.d;
r = await call('/api/passkey/register', { token: A.token, body: { challengeId: reg.challengeId, response: auth.create(reg.options) } }); ok(r.s === 400, 'passkey: another player cannot use my challenge', r);
r = await call('/api/passkey/register-options', { token: S.token, body: {} }); reg = r.d;
r = await call('/api/passkey/register', { token: S.token, body: { challengeId: reg.challengeId, response: auth.create({ ...reg.options, challenge: b64u(randomBytes(32)) }) } }); ok(r.s === 400, 'passkey: wrong challenge refused', r);
r = await call('/api/passkey/register-options', { token: S.token, body: {} }); reg = r.d;
r = await call('/api/passkey/register', { token: S.token, body: { challengeId: reg.challengeId, response: auth.create(reg.options) } }); ok(r.s === 200 && r.d.passkeys === 1, 'passkey registered', r);
r = await call('/api/passkey/register', { token: S.token, body: { challengeId: reg.challengeId, response: auth.create(reg.options) } }); ok(r.s === 400, 'passkey: a challenge works once', r);
r = await call('/api/me', { token: S.token }); ok(r.d.passkeys === 1, 'me counts the passkey', r.d);
r = await call('/api/passkey/register-options', { token: S.token, body: {} }); ok(r.d.options.excludeCredentials.length === 1, 'register options exclude the existing passkey', r.d.options);

r = await call('/api/passkey/login-options', { body: {} }); ok(r.s === 200 && r.d.options.challenge && r.d.options.rpId === RP_ID, 'passkey login options (signed out)', r.d);
let lo = r.d;
r = await call('/api/passkey/login', { body: { challengeId: lo.challengeId, response: auth.get(lo.options) } });
ok(r.s === 200 && r.d.token && r.d.player.id === S.player.id && r.d.group && r.d.passkeys === 1, 'passkey sign-in returns the account and its group', r.d);
const T3 = r.d.token;
r = await call('/api/me', { token: T3 }); ok(r.s === 200 && r.d.player.id === S.player.id, 'passkey device token works', r.d);
const replay = auth.get(lo.options);
r = await call('/api/passkey/login', { body: { challengeId: lo.challengeId, response: replay } }); ok(r.s === 400, 'passkey: login challenge works once', r);
r = await call('/api/passkey/login-options', { body: {} }); lo = r.d;
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
r = await call('/api/passkey/login', { body: { challengeId: lo.challengeId, response: auth.get(lo.options, { key: other }) } }); ok(r.s === 400, 'passkey: bad signature refused', r);
r = await call('/api/passkey/login-options', { body: {} }); lo = r.d;
r = await call('/api/passkey/login', { body: { challengeId: lo.challengeId, response: auth.get(lo.options, { id: randomBytes(16) }) } }); ok(r.s === 404, 'passkey: unknown credential -> 404', r);
r = await call('/api/passkey/login-options', { body: {} }); lo = r.d;
r = await call('/api/passkey/login', { body: { challengeId: lo.challengeId, response: auth.get(lo.options) } }); ok(r.s === 200 && r.d.player.id === S.player.id, 'passkey sign-in again (counter advanced)', r.d);
r = await call('/api/passkey/login-options', { body: {}, headers: { Origin: 'https://evil.example' } }); ok(r.s === 400, 'passkey login: unknown origin refused', r);

// ---- blocking
const course = (id, title) => ({ format: 'wonkolingo-course/1', id, title, description: 'd', units: [{ title: 'U1', lessons: [{ title: 'L1', items: [{ t: 'mc', p: 'Q1', o: ['a', 'b'], a: 0, x: 'because' }, { t: 'mc', p: 'Q2', o: ['c', 'd'], a: 1, x: 'why' }] }] }] });
r = await call('/api/groups', { body: { groupName: 'Block Testers', name: 'Kim' } }); const K = r.d;
r = await call('/api/join', { body: { code: K.code, name: 'Lee' } }); const L = r.d;
r = await call('/api/courses', { token: L.token, body: { course: course('lee-course', 'Lee’s course') } }); ok(r.s === 200, 'member publishes a course', r);
r = await call('/api/complete', { token: L.token, body: { lessonId: 'au0l0', title: 'Lee lesson', xp: 10, acc: 100, day: today } }); ok(r.s === 200, 'member posts a lesson', r);
r = await call('/api/block', { token: K.token, body: { playerId: K.player.id } }); ok(r.s === 400, 'cannot block yourself', r);
r = await call('/api/block', { token: K.token, body: { playerId: 'nosuchplayer' } }); ok(r.s === 404, 'block unknown player -> 404', r);
r = await call('/api/block', { token: K.token, body: { playerId: L.player.id } }); ok(r.s === 200, 'block a group member', r);
r = await call('/api/board', { token: K.token });
ok(!r.d.players.some(p => p.id === L.player.id) && !r.d.feed.some(f => f.id === L.player.id) && r.d.blocked.length === 1 && r.d.blocked[0].name === 'Lee', 'blocked player hidden from board and feed, listed as blocked', r.d);
r = await call('/api/courses', { token: K.token }); ok(r.d.courses.length === 0, 'blocked author’s courses hidden', r.d);
r = await call('/api/board', { token: L.token }); ok(r.d.players.some(p => p.id === K.player.id), 'blocking is one-way: the blocked player still sees the board', r.d.players);
r = await call('/api/unblock', { token: K.token, body: { playerId: L.player.id } }); ok(r.s === 200, 'unblock', r);
r = await call('/api/courses', { token: K.token }); ok(r.d.courses.length === 1, 'unblocked author’s course is back', r.d);

// ---- deleting an account
r = await call('/api/link', { token: L.token, body: {} });
r = await call('/api/link/claim', { body: { code: r.d.code } }); const L2 = r.d.token;
r = await call('/api/state', { token: L.token, body: { state: { srs: { x: { reps: 1 } } } } });
r = await call('/api/block', { token: L.token, body: { playerId: K.player.id } });
r = await call('/api/account/delete', { body: {} }); ok(r.s === 401, 'delete needs sign-in', r);
r = await call('/api/account/delete', { token: L.token, body: {} }); ok(r.s === 200, 'delete account', r);
r = await call('/api/me', { token: L.token }); ok(r.s === 401, 'deleted account’s token stops working', r.s);
r = await call('/api/me', { token: L2 }); ok(r.s === 401, 'deleted account’s other devices are signed out', r.s);
r = await call('/api/board', { token: K.token }); ok(r.d.players.length === 1 && !r.d.feed.some(f => f.id === L.player.id), 'deleted player and their lessons are gone from the board', r.d);
r = await call('/api/courses', { token: K.token }); ok(r.d.courses.length === 0, 'deleted player’s courses are gone', r.d);
r = await call('/api/account', { body: {} }); const D = r.d;
r = await call('/api/account/delete', { token: D.token, body: {} }); ok(r.s === 200, 'delete an account with no group', r);
r = await call('/api/me', { token: D.token }); ok(r.s === 401, 'no-group account is gone', r.s);

// ---- passkeys from the iPhone app: requests come from capacitor://localhost, iOS signs with the live site's origin
const LIVE = 'https://wonkolingo.alex-l-lintz.workers.dev', appHdr = { Origin: 'capacitor://localhost' };
const appAuth = makeAuthenticator(LIVE, new URL(LIVE).hostname);
r = await call('/api/account', { body: {} }); const N = r.d;
r = await call('/api/passkey/register-options', { token: N.token, body: {}, headers: appHdr }); ok(r.s === 200 && r.d.options.rp.id === 'wonkolingo.alex-l-lintz.workers.dev', 'app: register options use the live site as passkey site', r.d);
r = await call('/api/passkey/register', { token: N.token, body: { challengeId: r.d.challengeId, response: appAuth.create(r.d.options) }, headers: appHdr }); ok(r.s === 200 && r.d.passkeys === 1, 'app: passkey registered', r);
r = await call('/api/passkey/login-options', { body: {}, headers: appHdr }); const alo = r.d;
r = await call('/api/passkey/login', { body: { challengeId: alo.challengeId, response: appAuth.get(alo.options) }, headers: appHdr }); ok(r.s === 200 && r.d.player.id === N.player.id, 'app: passkey sign-in', r.d);
r = await call('/api/passkey/login-options', { body: {}, headers: appHdr }); const alo2 = r.d;
r = await call('/api/passkey/login', { body: { challengeId: alo2.challengeId, response: makeAuthenticator(ORIGIN, RP_ID).get(alo2.options) }, headers: appHdr }); ok(r.s === 404 || r.s === 400, 'app: a passkey for another site is refused', r);

// ---- removing a question records feedback
r = await call('/api/feedback/remove', { token: S.token, body: { course: 'lingo', card: 'u0l0#0', question: 'Q', reason: 'trivia' } }); ok(r.s === 200, 'removal feedback recorded', r);
r = await call('/api/feedback/remove', { token: S.token, body: { course: 'lingo', card: 'u0l0#0', question: 'Q', reason: 'restored' } }); ok(r.s === 200, 'restore recorded', r);
r = await call('/api/feedback/remove', { token: S.token, body: { course: 'lingo', card: 'u0l0#0', reason: 'hate it' } }); ok(r.s === 400, 'unknown reason refused', r);
r = await call('/api/feedback/remove', { token: S.token, body: { reason: 'trivia' } }); ok(r.s === 400, 'missing card refused', r);

// ---- the old flow still works for a page that hasn't updated
r = await call('/api/join', { body: { code, name: 'Legacy' } }); ok(r.s === 200 && r.d.token, 'signed-out join still creates a player', r);

console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
process.exit(failN ? 1 : 0);
