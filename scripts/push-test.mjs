// Sends one test push to a player's registered iPhones, straight to Apple from this Mac (node's http2; the Worker does
// the same in production). Usage: node scripts/push-test.mjs <playerId> ["message"]
// Needs ~/.config/wonkolingo/AuthKey_<KEYID>.p8 and wrangler access to the production database.
import http2 from 'node:http2';
import { createSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const [playerId, message = 'Test push from WonkoLingo. If you can read this, friend notifications work.'] = process.argv.slice(2);
if (!/^[a-z0-9]{6,20}$/.test(playerId || '')) { console.error('Usage: node scripts/push-test.mjs <playerId> ["message"]'); process.exit(2); }
const dir = homedir() + '/.config/wonkolingo';
const file = readdirSync(dir).find(f => /^AuthKey_[A-Z0-9]+\.p8$/.test(f));
const keyId = file.slice(8, -3), key = readFileSync(dir + '/' + file, 'utf8');
const b64u = b => Buffer.from(b).toString('base64url');
const unsigned = b64u(JSON.stringify({ alg: 'ES256', kid: keyId })) + '.' + b64u(JSON.stringify({ iss: '29B8GL5NYV', iat: Math.floor(Date.now() / 1000) }));
const jwt = unsigned + '.' + createSign('SHA256').update(unsigned).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'hill-speak', '--remote', '--json', '--command', `SELECT token, sandbox FROM push_tokens WHERE player_id = '${playerId}'`], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
const rows = JSON.parse(out)[0].results;
if (!rows.length) { console.log('No phones registered for', playerId); process.exit(1); }
for (const r of rows) {
  const host = r.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const res = await new Promise(done => {
    const c = http2.connect(host);
    const q = c.request({ ':method': 'POST', ':path': '/3/device/' + r.token, authorization: 'bearer ' + jwt, 'apns-topic': 'com.alexlintz.wonkolingo', 'apns-push-type': 'alert', 'content-type': 'application/json' });
    let status = 0, body = '';
    q.on('response', h => status = h[':status']); q.on('data', d => body += d); q.on('end', () => { c.close(); done({ status, body }); });
    q.end(JSON.stringify({ aps: { alert: { title: 'WonkoLingo', body: message }, sound: 'default' }, kind: 'test' }));
  });
  console.log(r.sandbox ? 'sandbox' : 'production', r.token.slice(0, 8) + '…', res.status, res.body || 'sent');
}
