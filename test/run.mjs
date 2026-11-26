// Local test: runs the Worker against a real SQLite database standing in for D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { _test } from '../src/index.js';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
sql.exec(readFileSync(new URL('../migrations/0002_admin.sql', import.meta.url), 'utf8'));
sql.exec(readFileSync(new URL('../migrations/0003_suspend.sql', import.meta.url), 'utf8'));
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
class Stmt { constructor(q){ this.q = q; this.args = []; } bind(...a){ this.args = a; return this; }
  async first(){ return sql.prepare(this.q).get(...this.args) ?? null; }
  async all(){ return { results: sql.prepare(this.q).all(...this.args) }; }
  async run(){ const r = sql.prepare(this.q).run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } }
const DB = { prepare: q => new Stmt(q), async batch(list){ sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch(e){ sql.exec('ROLLBACK'); throw e; } } };
const sent = [];
const env = { DB, ASSETS: { fetch: () => new Response('page') }, EMAIL: { send: async m => { sent.push(m); return { messageId: 'x' }; } },
  TURNSTILE_SECRET: 's', TURNSTILE_SITEKEY: 'k', MAIL_FROM: 'Game N Huat <noreply@gamenhuat.com>', POT_DEFAULT: '1000000',
  TRIAL_START: '2027-01-16', SHOWDOWN_START: '2027-02-06', EVENT_END: '2027-02-20', ALLOW_EARLY: '1', SHOW_CODES: '0',
  ACCESS_TEAM: 'epnox', ACCESS_AUD: 'AUD1', ADMIN_EMAILS: 'jk@epnox.com', MEDIA: { put: async () => {}, get: async () => null, delete: async () => {} } };
// Admin sign-in: a stand-in for Cloudflare Access with its own signing key.
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
const b64u = buf => Buffer.from(buf).toString('base64url');
async function accessJwt(email, aud = 'AUD1') {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64u(JSON.stringify({ email, aud: [aud], exp: Math.floor(clock / 1000) + 3600 }));
  return h + '.' + p + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p)));
}
globalThis.fetch = async u => String(u).includes('cloudflareaccess.com') ? new Response(JSON.stringify({ keys: [pub] }))
  : new Response(JSON.stringify({ success: true }));   // Turnstile always passes here

let clock = Date.parse('2026-11-25T02:00:00Z'); Date.now = () => clock;
const call = async (method, path, body, token, host = 'test.gamenhuat.com', extra = {}) => {
  const r = await worker.fetch(new Request('https://' + host + path, { method, headers: { 'content-type': 'application/json',
    ...(method === 'POST' ? { Origin: 'https://' + host, 'X-Requested-With': 'gnh' } : {}),
    ...(token ? { Cookie: '__Host-gnh_s=' + token } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil(){} });
  const out = { status: r.status, ...(await r.json()) };
  const set = r.headers.get('set-cookie') || '';
  const m = /__Host-gnh_s=([a-f0-9]*)/.exec(set);
  if (m) { out.token = m[1]; out.cookie = set; }
  return out;
};
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };
const lastCode = () => sent.at(-1).subject.match(/\d{6}/)[0];

// Card rules
const { bounds, outcome, checkEmail, checkPhone } = _test;
ok(JSON.stringify(bounds('AS', '5H')) === JSON.stringify({ v1: 14, v2: 5, low: 5, high: 14 }), 'Ace with 2–7 counts 14');
ok(bounds('AS', '9H').low === 1, 'Ace with 8–K counts 1');
ok(bounds('AS', 'AH').high === 14 && bounds('AS', 'AH').low === 1, 'two Aces are 1 and 14');
ok(outcome({ c1: '3S', c2: '9H', c3: '5D', low: 3, high: 9 }).points === 100, 'between wins 100');
ok(outcome({ c1: '3S', c2: '9H', c3: '9D', low: 3, high: 9 }).result === 'match', 'same rank is a double');
ok(outcome({ c1: '3S', c2: '9H', c3: 'AD', low: 3, high: 9 }).result === 'outside', 'third Ace without an Ace is outside');
ok(outcome({ c1: 'AS', c2: '9H', c3: 'AD', low: 1, high: 9 }).result === 'match', 'third Ace with an Ace is a double');
ok(checkEmail('J.K.Tan@Googlemail.com').key === 'jktan@gmail.com', 'Gmail dots and googlemail folded');
try { checkEmail('jk+1@epnox.com'); ok(false, 'plus refused'); } catch { ok(true, 'plus refused'); }
ok(checkPhone('012-345 6789') === '+60123456789', 'phone normalised to +60');

// Sign-up
let r = await call('POST', '/api/register', { name: 'Tan Ah Kow', email: 'tan@example.com', phone: '0123456789', agree: true, turnstile: 't' });
ok(r.status === 200 && sent.length === 1, 'register sends a code');
r = await call('POST', '/api/verify', { email: 'tan@example.com', code: '000000', device_id: 'aaaaaaaaaaaaaaaa' });
ok(r.status === 400, 'wrong code refused');
r = await call('POST', '/api/verify', { email: 'tan@example.com', code: lastCode(), device_id: 'aaaaaaaaaaaaaaaa' });
ok(r.token && r.pausedUntil === 0, 'right code gives a session');
const tokA = r.token;
r = await call('POST', '/api/register', { name: 'Tan', email: 't.a.n@example.com', phone: '0111111111', agree: true, turnstile: 't' });
ok(r.status === 200, 'different non-Gmail address may register');
clock += 61_000;
r = await call('POST', '/api/register', { name: 'Again', email: 'tan@example.com', phone: '0123456789', agree: true, turnstile: 't' });
ok(r.status === 409, 'duplicate email refused');

r = await call('POST', '/api/register', { name: 'Copy Cat', email: 'copy@example.com', phone: '123456789', agree: true, turnstile: 't' });
ok(r.status === 409 && /mobile number/.test(r.error), 'a phone number can only register once');

// Invites
let me = await call('GET', '/api/me', null, tokA);
await call('POST', '/api/register', { name: 'Lim Mei', email: 'lim@example.com', phone: '0198765432', agree: true, turnstile: 't', invite: me.inviteCode });
r = await call('POST', '/api/verify', { email: 'lim@example.com', code: lastCode(), device_id: 'bbbbbbbbbbbbbbbb' });
const tokB = r.token;
me = await call('GET', '/api/me', null, tokA);
ok(me.tries.extra === 1 && me.tries.daily === 3, 'invite gives the inviter 1 extra try');

// Playing
r = await call('POST', '/api/deal', null, tokA);
ok(r.hand && !('c3' in r.hand), 'deal hides the third card');
const again = await call('POST', '/api/deal', null, tokA);
ok(again.hand.id === r.hand.id, 'dealing again returns the same open hand');
me = await call('GET', '/api/me', null, tokA);
ok(me.tries.extra === 0 && me.tries.daily === 3, 'extra try used first, at the deal');
const res = await call('POST', '/api/choose', { hand_id: r.hand.id, go: true }, tokA);
const res2 = await call('POST', '/api/choose', { hand_id: r.hand.id, go: false }, tokA);
ok(res.result.c3 && res2.result.result === res.result.result, 'a hand is decided once only');
// Play out remaining tries, checking score never drops below zero
let n = 0, minScore = 0;
for (;;) { const d = await call('POST', '/api/deal', null, tokA); if (!d.hand) break; await call('POST', '/api/choose', { hand_id: d.hand.id, go: true }, tokA);
  const m = await call('GET', '/api/me', null, tokA); minScore = Math.min(minScore, m.score); if (++n > 40) break; }
me = await call('GET', '/api/me', null, tokA);
ok(me.tries.daily === 0 && minScore >= 0, `daily tries run out after ${n} more hands; score stayed ≥ 0 (now ${me.score})`);

// Leaving a hand without choosing: the game goes for it
r = await call('POST', '/api/deal', null, tokB); clock += 20_000;
me = await call('GET', '/api/me', null, tokB);
ok(me.openHand === null, 'expired hand is not shown as open');
const d2 = await call('POST', '/api/deal', null, tokB);
const hist = (await call('GET', '/api/me', null, tokB)).history;
ok(hist[0] && hist[0].choice === 'auto', 'expired hand was played automatically');

// One phone per account
clock += 61_000;
await call('POST', '/api/signin', { email: 'tan@example.com', turnstile: 't' });
r = await call('POST', '/api/verify', { email: 'tan@example.com', code: lastCode(), device_id: 'cccccccccccccccc' });
ok(r.pausedUntil > clock, 'new phone is paused for 1 hour');
const old = await call('GET', '/api/me', null, tokA);
ok(old.status === 401 && old.signedOut, 'earlier phone is signed out');
const dealPaused = await call('POST', '/api/deal', null, r.token);
ok(dealPaused.status === 423, 'paused phone cannot deal');

// Leaderboard
await worker.scheduled({}, env, { waitUntil: p => p });
await new Promise(res => setTimeout(res, 10));
const lbVisitor = await call('GET', '/api/leaderboard');
const lbMember = await call('GET', '/api/leaderboard', null, tokB);
ok(lbVisitor.rows.length <= 5 && !lbVisitor.signedIn, 'visitors get at most 5 rows');
ok(lbMember.signedIn, 'signed-in players get the full board');
console.log('leaderboard:', JSON.stringify(lbVisitor.rows));

// Admin panel
let a = await call('GET', '/api/admin/players', null, null, 'test.gamenhuat.com', { 'Cf-Access-Jwt-Assertion': await accessJwt('jk@epnox.com') });
ok(a.status === 404, 'admin is refused on the game address');
a = await call('GET', '/api/admin/players', null, null, 'admin.gamenhuat.com');
ok(a.status === 403, 'admin is refused without an Access sign-in');
a = await call('GET', '/api/admin/players', null, null, 'admin.gamenhuat.com', { 'Cf-Access-Jwt-Assertion': await accessJwt('someone@else.com') });
ok(a.status === 403, 'admin is refused for an email not on the list');
const forged = (await accessJwt('jk@epnox.com')).replace(/\.[^.]+$/, '.AAAA');
a = await call('GET', '/api/admin/players', null, null, 'admin.gamenhuat.com', { 'Cf-Access-Jwt-Assertion': forged });
ok(a.status === 403, 'admin is refused with a forged sign-in');
const adm = async (m, path, b) => call(m, path, b, null, 'admin.gamenhuat.com', { 'Cf-Access-Jwt-Assertion': await accessJwt('jk@epnox.com') });
a = await adm('GET', '/api/admin/players');
ok(a.status === 200 && a.rows.length >= 2 && 'reg_ip' in a.rows[0], `admin sees ${a.total} players with IP addresses`);
a = await adm('GET', '/api/admin/lockouts');
ok(a.rows.length === 1 && a.rows[0].pauses === 1, 'locked-out history lists the paused player');
await adm('POST', '/api/admin/sponsors', { name: 'Kedai A', url: 'https://example.com', kind: 'popup', image_key: 'pop.png', logo_key: 'logo.png', active: true });
await adm('POST', '/api/admin/sponsors', { name: 'Old', url: 'https://example.com', kind: 'banner', image_key: 'b.png', active: true, end_day: '2026-01-01' });
await adm('POST', '/api/admin/prizes', { place: '1st', name: 'Shopping voucher', value: 'RM500', sponsor: 'Kedai A', image_key: 'p.png' });
const c = await call('GET', '/api/content');
ok(c.popups.length === 1 && c.banners.length === 0 && c.logos.length === 1 && c.prizes.length === 1, 'content shows active sponsors and prizes only');
a = await adm('POST', '/api/admin/pot', { day: '2026-11-26', pot_start: 500050 });
const pot = await adm('GET', '/api/admin/pot');
ok(pot.rows.some(r => r.day === '2026-11-26' && r.pot_start === 500100), 'admin sets a day\'s ang pow, rounded to 100');
const list = (await adm('GET', '/api/admin/players')).rows;
const lim = list.find(r => r.email === 'lim@example.com'), tan = list.find(r => r.email === 'tan@example.com');
a = await adm('POST', '/api/admin/player', { id: lim.id, phone: tan.phone });
ok(a.status === 409, 'admin cannot give a player a number someone else has');
a = await adm('POST', '/api/admin/player', { id: lim.id, phone: '0177777777' });
ok(a.status === 200 && a.phone === '+60177777777', 'admin changes a mobile number');
a = await adm('POST', '/api/admin/player/reset', { id: tan.id });
ok(a.status === 200, 'admin resets a sign-in');
clock += 61_000;
await call('POST', '/api/signin', { email: 'tan@example.com', turnstile: 't' });
r = await call('POST', '/api/verify', { email: 'tan@example.com', code: lastCode(), device_id: 'dddddddddddddddd' });
ok(r.token && r.pausedUntil === 0, 'after a reset the player signs in on a new phone with no pause');
// Admin page and security headers (from the penetration test report)
const raw = async (path, host, extra = {}) => worker.fetch(new Request('https://' + host + path, { headers: extra }), env, { waitUntil(){} });
let hres = await raw('/admin/', 'test.gamenhuat.com');
ok(hres.status === 404, 'admin page is not served on the game address');
hres = await raw('/admin/', 'admin.gamenhuat.com');
ok(hres.status === 404, 'admin page is not served without an admin sign-in');
hres = await raw('/admin/', 'admin.gamenhuat.com', { 'Cf-Access-Jwt-Assertion': await accessJwt('jk@epnox.com') });
ok(hres.status === 200 && hres.headers.get('cache-control') === 'no-store', 'admin page is served to a signed-in admin, never cached');
hres = await raw('/api/leaderboard', 'test.gamenhuat.com');
ok(['strict-transport-security', 'x-frame-options', 'x-content-type-options', 'content-security-policy', 'referrer-policy', 'permissions-policy'].every(h => hres.headers.get(h)), 'security headers are on every response');

// Sign-in cookie, other-website requests and server sign-out (from the security reviews)
r = await call('POST', '/api/signin', { email: 'lim@example.com', turnstile: 't' }, null, 'test.gamenhuat.com', { Origin: 'https://evil.example' });
ok(r.status === 403, 'requests from another website are refused');
r = await worker.fetch(new Request('https://test.gamenhuat.com/api/deal', { method: 'POST', headers: { Origin: 'https://test.gamenhuat.com', Cookie: '__Host-gnh_s=' + tokB } }), env, { waitUntil(){} });
ok(r.status === 403, 'requests without the page header are refused');
clock += 61_000;
await call('POST', '/api/signin', { email: 'lim@example.com', turnstile: 't' });
r = await call('POST', '/api/verify', { email: 'lim@example.com', code: lastCode(), device_id: 'bbbbbbbbbbbbbbbb' });
ok(/HttpOnly/.test(r.cookie) && /Secure/.test(r.cookie) && /SameSite=Strict/.test(r.cookie) && !('tokenInBody' in r), 'sign-in is a Secure, HttpOnly, SameSite=Strict cookie');
const limTok = r.token;
r = await call('POST', '/api/signout', {}, limTok);
ok(r.status === 200 && /Max-Age=0/.test(r.cookie), 'sign-out clears the cookie');
r = await call('GET', '/api/me', null, limTok);
ok(r.status === 401, 'a signed-out sign-in can no longer be used');
clock += 61_000;
await call('POST', '/api/signin', { email: 'lim@example.com', turnstile: 't' });
r = await call('POST', '/api/verify', { email: 'lim@example.com', code: lastCode(), device_id: 'bbbbbbbbbbbbbbbb' });
ok(r.pausedUntil === 0, 'signing back in on the same phone after sign-out has no pause');
clock += 61_000;
await call('POST', '/api/signin', { email: 'lim@example.com', turnstile: 't' });
r = await call('POST', '/api/verify', { email: 'lim@example.com', code: lastCode(), device_id: 'eeeeeeeeeeeeeeee' });
ok(r.pausedUntil > clock, 'signing in on another phone after sign-out still pauses for 1 hour');

// Admin: names, suspensions; masked leaderboard names
ok(_test.shortName('Tan Ah Kow') === 'Tan *****' && _test.shortName('Ali') === 'Ali' && _test.shortName('Mona') === 'Mona', 'leaderboard names keep 4 characters, the rest is *****');
const tanRow = (await adm('GET', '/api/admin/players')).rows.find(x => x.email === 'tan@example.com');
a = await adm('POST', '/api/admin/player', { id: tanRow.id, name: 'Tan Ah Seng' });
ok(a.status === 200 && a.name === 'Tan Ah Seng', 'admin edits a name');
clock += 61_000;
await call('POST', '/api/signin', { email: 'tan@example.com', turnstile: 't' });
r = await call('POST', '/api/verify', { email: 'tan@example.com', code: lastCode(), device_id: 'dddddddddddddddd' });
const tanTok = r.token;
a = await adm('POST', '/api/admin/player/suspend', { id: tanRow.id, suspended: true });
ok(a.status === 200, 'admin suspends a player');
r = await call('GET', '/api/me', null, tanTok);
ok(r.status === 401, 'a suspended player is signed out straight away');
clock += 61_000;
r = await call('POST', '/api/signin', { email: 'tan@example.com', turnstile: 't' });
ok(r.status === 403 && r.suspended, 'a suspended player cannot sign in');
await worker.scheduled({}, env, { waitUntil: p => p }); await new Promise(res => setTimeout(res, 10));
const lb = await call('GET', '/api/leaderboard');
ok(!lb.rows.some(x => x.name.startsWith('Tan ')), 'a suspended player is left off the leaderboard');
a = await adm('POST', '/api/admin/player/suspend', { id: tanRow.id, suspended: false });
clock += 61_000;
r = await call('POST', '/api/signin', { email: 'tan@example.com', turnstile: 't' });
ok(r.status === 200, 'an unsuspended player can sign in again');
