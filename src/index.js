// Game N Huat – Challenge the Banker: game server (Cloudflare Worker).
// Everything that decides a result happens here. The phone only shows what this server sends.

const DAILY_TRIES = 3;          // free tries each day; unused ones expire
const EXTRA_PER_DAY = 5;        // most extra tries (from invites) usable in one day
const BET = 100;                // fixed points per hand
const CHOICE_MS = 10_000;       // 10-second choice timer
const GRACE_MS = 3_000;         // allowance for slow networks before the server goes for it
const PAUSE_MS = 60 * 60_000;   // 1-hour pause when an account moves to another phone
const VISIT_MS = 6 * 60 * 60_000; // one Turnstile check covers a visit of up to 6 hours
const CODE_MS = 10 * 60_000;    // email codes expire after 10 minutes
const CODE_TRIES = 5;           // wrong guesses allowed per code
const CODE_GAP_MS = 60_000;     // at least 1 minute between code emails
const CODE_PER_HOUR = 5;        // at most 5 code emails per address per hour
const MYT_MS = 8 * 60 * 60_000; // Malaysia is UTC+8

const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
  // Every 5 minutes: rebuild the leaderboard.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuildLeaderboard(env, Date.now()));
  },
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function route(request, env, url, ctx) {
  const now = Date.now();
  const p = url.pathname, m = request.method;
  if (m === 'POST' && p === '/api/register') return register(env, await body(request), request, now);
  if (m === 'POST' && p === '/api/signin') return signin(env, await body(request), request, now);
  if (m === 'POST' && p === '/api/verify') return verify(env, await body(request), now);
  if (m === 'GET' && p === '/api/leaderboard') return leaderboard(env, request, now);
  if (m === 'GET' && p === '/api/config') return json({ turnstileSiteKey: env.TURNSTILE_SITEKEY });

  const s = await session(env, request);                       // everything below needs a signed-in phone
  if (m === 'POST' && p === '/api/visit') return visit(env, s, await body(request), request, now);
  if (m === 'GET' && p === '/api/me') return json(await state(env, s, now));
  if (m === 'POST' && p === '/api/deal') return deal(env, s, now);
  if (m === 'POST' && p === '/api/choose') return choose(env, s, await body(request), now);
  fail(404, 'Not found.');
}

async function body(request) {
  try { return await request.json(); } catch { fail(400, 'Bad request.'); }
}

/* ---------------- dates and phases ---------------- */

const dayOf = now => new Date(now + MYT_MS).toISOString().slice(0, 10);

function phase(env, day) {
  if (day > env.EVENT_END) return 'ended';
  if (day >= env.SHOWDOWN_START) return 'showdown';
  if (day >= env.TRIAL_START || env.ALLOW_EARLY === '1') return 'trial';
  return 'not_started';
}

/* ---------------- checks on what players type ---------------- */

function checkEmail(raw) {
  const email = String(raw || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) fail(400, 'Please enter a valid email address.');
  let [local, domain] = email.toLowerCase().split('@');
  if (local.includes('+')) fail(400, 'Email addresses with "+" are not allowed.');
  if (DISPOSABLE.has(domain)) fail(400, 'Temporary email addresses are not allowed.');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');  // Gmail ignores dots
  return { email, key: local + '@' + domain };
}

function checkPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^60/, '').replace(/^0/, '');
  if (!/^1\d{8,9}$/.test(digits)) fail(400, 'Please enter a Malaysian mobile number, for example 12 345 6789.');
  return '+60' + digits;
}

function checkName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) fail(400, 'Please enter your name.');
  return name;
}

/* ---------------- Turnstile ---------------- */

async function turnstile(env, token, request) {
  if (!token) fail(400, 'Please complete the human check.');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await r.json();
  if (!out.success) fail(403, 'The human check failed. Please reload the page and try again.');
}

/* ---------------- email codes ---------------- */

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randomInt = max => crypto.getRandomValues(new Uint32Array(1))[0] % max;  // fine for max far below 2^32
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

async function sendCode(env, emailKey, email, purpose, payload, now) {
  const old = await env.DB.prepare('SELECT * FROM codes WHERE email_key = ?').bind(emailKey).first();
  let sends = 1, windowStart = now;
  if (old) {
    if (now - old.last_sent_at < CODE_GAP_MS) fail(429, 'Please wait a minute before asking for another code.');
    if (now - old.window_start < 60 * 60_000) {
      if (old.sends >= CODE_PER_HOUR) fail(429, 'Too many codes requested. Please try again in an hour.');
      sends = old.sends + 1; windowStart = old.window_start;
    }
  }
  const code = String(100000 + randomInt(900000));
  await env.DB.prepare(`INSERT INTO codes (email_key, purpose, code_hash, payload, expires_at, attempts, sends, window_start, last_sent_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(email_key) DO UPDATE SET purpose = excluded.purpose, code_hash = excluded.code_hash, payload = excluded.payload,
        expires_at = excluded.expires_at, attempts = 0, sends = excluded.sends, window_start = excluded.window_start, last_sent_at = excluded.last_sent_at`)
    .bind(emailKey, purpose, await sha256(emailKey + ':' + code), payload ? JSON.stringify(payload) : null,
      now + CODE_MS, sends, windowStart, now).run();

  if (env.SHOW_CODES === '1') return code;                    // test site only, before email sending is ready
  await env.EMAIL.send({
    from: env.MAIL_FROM,
    to: email,
    subject: `Your Challenge the Banker code: ${code}`,
    text: `Your code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this code, you can ignore this email.\n\nGame N Huat · gamenhuat.com`,
    html: `<p>Your code is <b style="font-size:20px;letter-spacing:2px">${code}</b>. It expires in 10 minutes.</p>
           <p>If you did not ask for this code, you can ignore this email.</p><p>Game N Huat · gamenhuat.com</p>`,
  });
  return null;
}

/* ---------------- sign-up, sign-in and the one-phone rule ---------------- */

async function register(env, b, request, now) {
  const name = checkName(b.name), { email, key } = checkEmail(b.email), phone = checkPhone(b.phone);
  if (b.agree !== true) fail(400, 'Please tick the box to agree before registering.');
  await turnstile(env, b.turnstile, request);
  const taken = await env.DB.prepare('SELECT 1 FROM players WHERE email_key = ?').bind(key).first();
  if (taken) fail(409, 'Already registered. Sign in.');
  const invite = String(b.invite || '').trim().toUpperCase().slice(0, 12) || null;
  const shown = await sendCode(env, key, email, 'register', { name, email, phone, invite, consent_at: now }, now);
  return json({ ok: true, ...(shown ? { testCode: shown } : {}) });
}

async function signin(env, b, request, now) {
  const { email, key } = checkEmail(b.email);
  await turnstile(env, b.turnstile, request);
  const player = await env.DB.prepare('SELECT id, email FROM players WHERE email_key = ?').bind(key).first();
  if (!player) fail(404, 'Email not registered.');
  const shown = await sendCode(env, key, player.email, 'signin', null, now);
  return json({ ok: true, ...(shown ? { testCode: shown } : {}) });
}

async function verify(env, b, now) {
  const { key } = checkEmail(b.email);
  const deviceId = String(b.device_id || '');
  if (!/^[a-f0-9-]{16,64}$/.test(deviceId)) fail(400, 'Bad request.');
  const row = await env.DB.prepare('SELECT * FROM codes WHERE email_key = ?').bind(key).first();
  if (!row || row.expires_at < now) fail(400, 'This code has expired. Please ask for a new one.');
  if (row.attempts >= CODE_TRIES) fail(429, 'Too many wrong codes. Please ask for a new one.');
  if (await sha256(key + ':' + String(b.code || '').trim()) !== row.code_hash) {
    await env.DB.prepare('UPDATE codes SET attempts = attempts + 1 WHERE email_key = ?').bind(key).run();
    fail(400, 'That code is not right. Please check and try again.');
  }
  await env.DB.prepare('DELETE FROM codes WHERE email_key = ?').bind(key).run();

  let playerId;
  if (row.purpose === 'register') {
    const d = JSON.parse(row.payload);
    const exists = await env.DB.prepare('SELECT id FROM players WHERE email_key = ?').bind(key).first();
    if (exists) fail(409, 'Already registered. Sign in.');
    const inviter = d.invite ? await env.DB.prepare('SELECT id FROM players WHERE invite_code = ?').bind(d.invite).first() : null;
    const res = await env.DB.prepare(`INSERT INTO players (email_key, email, name, phone, consent_at, invite_code, invited_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(key, d.email, d.name, d.phone, d.consent_at, await newInviteCode(env), inviter ? inviter.id : null, now).run();
    playerId = res.meta.last_row_id;
    const batch = [audit(env, now, playerId, 'register', d.phone)];
    if (inviter) batch.push(env.DB.prepare('UPDATE players SET extra_tries = extra_tries + 1 WHERE id = ?').bind(inviter.id),
                            audit(env, now, inviter.id, 'invite_earned', String(playerId)));
    await env.DB.batch(batch);
  } else {
    playerId = (await env.DB.prepare('SELECT id FROM players WHERE email_key = ?').bind(key).first()).id;
  }

  // One phone per account: an earlier phone loses its key; this phone waits 1 hour if another phone held the account.
  const old = await env.DB.prepare('SELECT device_id, paused_until FROM sessions WHERE player_id = ?').bind(playerId).first();
  const otherPhone = old && old.device_id !== deviceId;
  const pausedUntil = otherPhone ? now + PAUSE_MS : (old ? old.paused_until : 0);
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (player_id, token_hash, device_id, paused_until, verified_until, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET token_hash = excluded.token_hash, device_id = excluded.device_id,
          paused_until = excluded.paused_until, verified_until = excluded.verified_until, created_at = excluded.created_at`)
      .bind(playerId, await sha256(token), deviceId, pausedUntil, now + VISIT_MS, now),   // the code email counts as this visit's check
    env.DB.prepare('INSERT OR IGNORE INTO devices (player_id, device_id, first_seen) VALUES (?, ?, ?)').bind(playerId, deviceId, now),
    ...(otherPhone ? [audit(env, now, playerId, 'pause', 'signed in on another phone')] : []),
  ]);
  return json({ token, pausedUntil });
}

async function newInviteCode(env) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0/O or 1/I to avoid mix-ups
  for (;;) {
    let c = ''; for (let i = 0; i < 7; i++) c += letters[randomInt(letters.length)];
    if (!await env.DB.prepare('SELECT 1 FROM players WHERE invite_code = ?').bind(c).first()) return c;
  }
}

const audit = (env, now, playerId, kind, detail) =>
  env.DB.prepare('INSERT INTO audit (at, player_id, kind, detail) VALUES (?, ?, ?, ?)').bind(now, playerId, kind, detail || null);

async function session(env, request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, 'Please sign in.');
  const s = await env.DB.prepare(`SELECT s.*, p.name, p.invite_code, p.extra_tries, p.total_score FROM sessions s
      JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!s) fail(401, 'Signed in on another device. Paused 1 hour.', { signedOut: true });
  return s;
}

async function visit(env, s, b, request, now) {
  await turnstile(env, b.turnstile, request);
  await env.DB.prepare('UPDATE sessions SET verified_until = ? WHERE player_id = ?').bind(now + VISIT_MS, s.player_id).run();
  return json({ ok: true });
}

function mustPlay(s, now) {
  if (s.paused_until > now) fail(423, 'Signed in on another device.', { pausedUntil: s.paused_until });
  if (s.verified_until < now) fail(403, 'Please complete the human check.', { needVisit: true });
}

/* ---------------- the banker's ang pow ---------------- */

async function today(env, day) {
  await env.DB.prepare('INSERT OR IGNORE INTO days (day, pot_start, pot_paid) VALUES (?, ?, 0)').bind(day, Number(env.POT_DEFAULT)).run();
  return env.DB.prepare('SELECT * FROM days WHERE day = ?').bind(day).first();
}
const potLeft = d => Math.max(0, Math.floor((d.pot_start - d.pot_paid) / 100) * 100);   // shown in 100s

async function myDay(env, playerId, day) {
  await env.DB.prepare('INSERT OR IGNORE INTO player_days (player_id, day) VALUES (?, ?)').bind(playerId, day).run();
  return env.DB.prepare('SELECT * FROM player_days WHERE player_id = ? AND day = ?').bind(playerId, day).first();
}

function triesLeft(s, pd) {
  const extraUsable = Math.min(s.extra_tries, EXTRA_PER_DAY - pd.extra_used);
  return { daily: Math.max(0, DAILY_TRIES - pd.daily_used), extra: Math.max(0, extraUsable), extraBanked: s.extra_tries };
}

/* ---------------- cards ---------------- */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const rankOf = card => RANKS.indexOf(card.slice(0, -1)) + 1;     // A = 1 … K = 13

function drawThree() {                                           // a fresh 52-card deck every hand
  const deck = []; for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > deck.length - 4; i--) { const j = randomInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck.slice(-3);
}

// Aces count as 1 or 14, whichever gives the wider gap: with 2–7 the Ace is 14, with 8–K it is 1, two Aces are 1 and 14.
function bounds(c1, c2) {
  let a = rankOf(c1), b = rankOf(c2);
  if (a === 1 && b === 1) return { v1: 1, v2: 14, low: 1, high: 14 };
  if (a === 1) a = b <= 7 ? 14 : 1;
  if (b === 1) b = a <= 7 ? 14 : 1;
  return { v1: a, v2: b, low: Math.min(a, b), high: Math.max(a, b) };
}

function outcome(h) {
  const r3 = rankOf(h.c3);
  if (r3 === rankOf(h.c1) || r3 === rankOf(h.c2)) return { result: 'match', points: 2 * BET };
  if (r3 === 1) return { result: 'outside', points: -BET };       // a third Ace only counts if you hold an Ace
  return r3 > h.low && r3 < h.high ? { result: 'between', points: BET } : { result: 'outside', points: -BET };
}

/* ---------------- playing ---------------- */

async function deal(env, s, now) {
  mustPlay(s, now);
  const day = dayOf(now), ph = phase(env, day);
  if (ph === 'not_started' || ph === 'ended') fail(403, ph === 'ended' ? 'The game has ended. Thank you for playing!' : 'The game has not started yet.');

  const open = await env.DB.prepare("SELECT * FROM hands WHERE player_id = ? AND status = 'open'").bind(s.player_id).first();
  if (open) {
    if (open.deadline + GRACE_MS < now) await settle(env, s, open, 'auto', now);   // left without choosing: the game went for it
    else return json({ hand: publicHand(open, now) });                             // same hand again; no new try used
  }

  const d = await today(env, day);
  if (d.pot_start - d.pot_paid <= 0) fail(409, 'Banker has been beaten! Come back tomorrow!', { beaten: true });
  const pd = await myDay(env, s.player_id, day);
  const left = triesLeft(s, pd);
  const kind = left.extra > 0 ? 'extra' : left.daily > 0 ? 'daily' : null;      // extra tries are used first
  if (!kind) fail(409, 'No tries left today. Invite friends for more, or come back tomorrow.', { noTries: true });

  const [c1, c2, c3] = drawThree(), b = bounds(c1, c2);
  const hand = { id: crypto.randomUUID(), player_id: s.player_id, day, c1, c2, c3, low: b.low, high: b.high, try_kind: kind,
    deadline: now + CHOICE_MS, created_at: now };
  // The try is used up at the deal, so closing the app on a bad hand does not save it.
  const used = kind === 'extra'
    ? env.DB.prepare(`UPDATE player_days SET extra_used = extra_used + 1, hands = hands + 1 WHERE player_id = ? AND day = ?
        AND extra_used < ? AND (SELECT extra_tries FROM players WHERE id = ?) > 0`).bind(s.player_id, day, EXTRA_PER_DAY, s.player_id)
    : env.DB.prepare(`UPDATE player_days SET daily_used = daily_used + 1, hands = hands + 1 WHERE player_id = ? AND day = ? AND daily_used < ?`)
        .bind(s.player_id, day, DAILY_TRIES);
  const [u] = await env.DB.batch([used]);
  if (!u.meta.changes) fail(409, 'No tries left today.', { noTries: true });       // two taps at once: only one wins
  const batch = [env.DB.prepare(`INSERT INTO hands (id, player_id, day, c1, c2, c3, low, high, try_kind, deadline, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(hand.id, s.player_id, day, c1, c2, c3, b.low, b.high, kind, hand.deadline, now)];
  if (kind === 'extra') batch.push(env.DB.prepare('UPDATE players SET extra_tries = extra_tries - 1 WHERE id = ?').bind(s.player_id));
  await env.DB.batch(batch);
  return json({ hand: publicHand(hand, now) });
}

function publicHand(h, now) {                                    // never includes the third card
  const b = bounds(h.c1, h.c2);
  return { id: h.id, c1: h.c1, c2: h.c2, v1: b.v1, v2: b.v2, low: b.low, high: b.high, secondsLeft: Math.max(0, Math.ceil((h.deadline - now) / 1000)) };
}

async function choose(env, s, b, now) {
  if (s.paused_until > now) fail(423, 'Signed in on another device.', { pausedUntil: s.paused_until });
  const h = await env.DB.prepare('SELECT * FROM hands WHERE id = ? AND player_id = ?').bind(String(b.hand_id || ''), s.player_id).first();
  if (!h) fail(404, 'Hand not found.');
  if (h.status !== 'open') return json({ result: reveal(h) });   // already decided: show the same result again
  const late = h.deadline + GRACE_MS < now;
  const choice = late ? 'auto' : (b.go === true ? 'go' : 'skip');
  const done = await settle(env, s, h, choice, now);
  return json({ result: done });
}

// Decides one hand exactly once, even if two requests arrive together.
async function settle(env, s, h, choice, now) {
  const go = choice !== 'skip';
  const o = go ? outcome(h) : { result: 'skip', points: 0 };
  const claim = await env.DB.prepare(`UPDATE hands SET status = 'done', choice = ?, result = ?, points = ?, decided_at = ?
      WHERE id = ? AND status = 'open'`).bind(choice, o.result, o.points, now, h.id).run();
  if (!claim.meta.changes) {
    const again = await env.DB.prepare('SELECT * FROM hands WHERE id = ?').bind(h.id).first();
    return reveal(again);
  }
  const showdown = phase(env, h.day) === 'showdown';
  const batch = [];
  if (o.points) {
    batch.push(env.DB.prepare('UPDATE player_days SET score = MAX(0, score + ?) WHERE player_id = ? AND day = ?').bind(o.points, s.player_id, h.day));
    batch.push(env.DB.prepare('UPDATE days SET pot_paid = pot_paid + ? WHERE day = ?').bind(o.points, h.day));
    if (showdown) batch.push(env.DB.prepare('UPDATE players SET total_score = MAX(0, total_score + ?) WHERE id = ?').bind(o.points, s.player_id));
  }
  if (o.result === 'match') {                                    // a double gives the try back
    batch.push(h.try_kind === 'extra'
      ? env.DB.prepare('UPDATE player_days SET extra_used = extra_used - 1 WHERE player_id = ? AND day = ?').bind(s.player_id, h.day)
      : env.DB.prepare('UPDATE player_days SET daily_used = daily_used - 1 WHERE player_id = ? AND day = ?').bind(s.player_id, h.day));
    if (h.try_kind === 'extra') batch.push(env.DB.prepare('UPDATE players SET extra_tries = extra_tries + 1 WHERE id = ?').bind(s.player_id));
  }
  if (batch.length) await env.DB.batch(batch);
  return reveal({ ...h, status: 'done', choice, result: o.result, points: o.points });
}

function reveal(h) {
  const b = bounds(h.c1, h.c2);
  return { id: h.id, c1: h.c1, c2: h.c2, c3: h.c3, v1: b.v1, v2: b.v2, choice: h.choice, result: h.result, points: h.points };
}

/* ---------------- what the phone shows ---------------- */

async function state(env, s, now) {
  const day = dayOf(now), d = await today(env, day), pd = await myDay(env, s.player_id, day);
  const fresh = await env.DB.prepare('SELECT extra_tries, total_score FROM players WHERE id = ?').bind(s.player_id).first();
  const open = await env.DB.prepare("SELECT * FROM hands WHERE player_id = ? AND status = 'open'").bind(s.player_id).first();
  const history = await env.DB.prepare(`SELECT c1, c2, c3, choice, result, points FROM hands
      WHERE player_id = ? AND day = ? AND status = 'done' ORDER BY created_at`).bind(s.player_id, day).all();
  const ph = phase(env, day);
  return {
    name: s.name, inviteCode: s.invite_code, day, phase: ph,
    tries: triesLeft({ ...s, extra_tries: fresh.extra_tries }, pd),
    score: pd.score, totalScore: fresh.total_score,
    potLeft: potLeft(d), potStart: d.pot_start, beaten: d.pot_start - d.pot_paid <= 0,
    pausedUntil: s.paused_until > now ? s.paused_until : 0, needVisit: s.verified_until < now,
    openHand: open && open.deadline + GRACE_MS >= now ? publicHand(open, now) : null,
    history: history.results,
  };
}

/* ---------------- leaderboard ---------------- */

const shortName = n => { const w = n.split(' '); return w.length > 1 ? w[0] + ' ' + w[w.length - 1][0] + '.' : w[0]; };  // "Tan Ah Kow" → "Tan K."

async function rebuildLeaderboard(env, now) {
  const day = dayOf(now), board = phase(env, day) === 'showdown' ? 'showdown' : 'daily';
  const rows = board === 'showdown'
    ? await env.DB.prepare('SELECT name, total_score AS score FROM players WHERE total_score > 0 ORDER BY total_score DESC, id LIMIT 50').all()
    : await env.DB.prepare(`SELECT p.name, d.score FROM player_days d JOIN players p ON p.id = d.player_id
        WHERE d.day = ? AND d.score > 0 ORDER BY d.score DESC, d.player_id LIMIT 50`).bind(day).all();
  const batch = [env.DB.prepare('DELETE FROM leaderboard WHERE board = ?').bind(board)];
  rows.results.forEach((r, i) => batch.push(env.DB.prepare('INSERT INTO leaderboard (board, rank, name, score, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(board, i + 1, shortName(r.name), r.score, now)));
  await env.DB.batch(batch);
}

async function leaderboard(env, request, now) {
  const board = phase(env, dayOf(now)) === 'showdown' ? 'showdown' : 'daily';
  let signedIn = false;
  try { await session(env, request); signedIn = true; } catch { /* visitors see the top 5 */ }
  const rows = await env.DB.prepare('SELECT rank, name, score, updated_at FROM leaderboard WHERE board = ? ORDER BY rank LIMIT ?')
    .bind(board, signedIn ? 50 : 5).all();
  return json({ board, signedIn, rows: rows.results.map(({ rank, name, score }) => ({ rank, name, score })),
    updatedAt: rows.results[0] ? rows.results[0].updated_at : null });
}

// Exported for tests.
export const _test = { bounds, outcome, checkEmail, checkPhone, dayOf, shortName, drawThree };
