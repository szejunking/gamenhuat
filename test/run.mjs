// Local test: runs the Worker against a real SQLite database standing in for D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { _test } from '../src/index.js';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
class Stmt { constructor(q){ this.q = q; this.args = []; } bind(...a){ this.args = a; return this; }
  async first(){ return sql.prepare(this.q).get(...this.args) ?? null; }
  async all(){ return { results: sql.prepare(this.q).all(...this.args) }; }
  async run(){ const r = sql.prepare(this.q).run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } }
const DB = { prepare: q => new Stmt(q), async batch(list){ sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch(e){ sql.exec('ROLLBACK'); throw e; } } };
const sent = [];
const env = { DB, ASSETS: { fetch: () => new Response('page') }, EMAIL: { send: async m => { sent.push(m); return { messageId: 'x' }; } },
  TURNSTILE_SECRET: 's', TURNSTILE_SITEKEY: 'k', MAIL_FROM: 'Game N Huat <noreply@gamenhuat.com>', POT_DEFAULT: '1000000',
  TRIAL_START: '2027-01-16', SHOWDOWN_START: '2027-02-06', EVENT_END: '2027-02-20', ALLOW_EARLY: '1', SHOW_CODES: '0' };
globalThis.fetch = async () => new Response(JSON.stringify({ success: true }));   // Turnstile always passes here

let clock = Date.parse('2026-11-25T02:00:00Z'); Date.now = () => clock;
const call = async (method, path, body, token) => {
  const r = await worker.fetch(new Request('https://test.gamenhuat.com' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil(){} });
  return { status: r.status, ...(await r.json()) };
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
r = await call('POST', '/api/register', { name: 'Tan', email: 't.a.n@example.com', phone: '0123456789', agree: true, turnstile: 't' });
ok(r.status === 200, 'different non-Gmail address may register');
clock += 61_000;
r = await call('POST', '/api/register', { name: 'Again', email: 'tan@example.com', phone: '0123456789', agree: true, turnstile: 't' });
ok(r.status === 409, 'duplicate email refused');

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
