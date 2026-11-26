// Game N Huat – Beat the Banker: game server (Cloudflare Worker).
// Everything that decides a result happens here. The phone only shows what this server sends.

let DAILY_TRIES = 3;            // free tries each day; unused ones expire (DAILY_TRIES in wrangler.jsonc overrides)
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
    DAILY_TRIES = Math.max(1, Math.min(50, Number(env.DAILY_TRIES) || 3));
    const url = new URL(request.url);
    return secure(await handle(request, env, url, ctx));
  },
  // Every 5 minutes: rebuild the leaderboard.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuildLeaderboard(env, Date.now()));
  },
};

async function handle(request, env, url, ctx) {
  try {
    if (url.pathname.startsWith('/media/')) return await media(env, url);
    // The admin page is only served on admin.gamenhuat.com, and only to a signed-in admin.
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      try { await adminEmail(env, request, url, Date.now()); }
      catch (e) { return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }); }
      const page = await env.ASSETS.fetch(request);
      const res = new Response(page.body, page);
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    if (!url.pathname.startsWith('/api/')) return await env.ASSETS.fetch(request);
    return await route(request, env, url, ctx);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
    console.error(err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

// Security headers on everything the Worker sends (the same list is in public/_headers for files served directly).
const CSP = ["default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://www.googletagmanager.com https://*.google-analytics.com",
  "connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join('; ');
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Content-Security-Policy': CSP,
};
function secure(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

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
  sameSiteOnly(request, url);
  if (m === 'POST' && p === '/api/signout') return signout(env, request);
  if (m === 'POST' && p === '/api/register') return register(env, await body(request), request, now);
  if (m === 'POST' && p === '/api/signin') return signin(env, await body(request), request, now);
  if (m === 'POST' && p === '/api/verify') return verify(env, await body(request), request, now);
  if (m === 'GET' && p === '/api/content') return content(env, request, now, ctx);
  if (p.startsWith('/api/admin/')) return admin(env, request, url, now);
  if (m === 'GET' && p === '/api/leaderboard') return leaderboard(env, request, now);
  if (m === 'GET' && p === '/api/config') return json({ turnstileSiteKey: env.TURNSTILE_SITEKEY, gaId: env.GA_ID || null, dailyTries: DAILY_TRIES });

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

/* ---------------- sign-in cookie and protection against requests from other websites ---------------- */

const COOKIE = '__Host-gnh_s';            // __Host- cookies: https only, this exact site, whole path
const SESSION_DAYS = 60;                  // a sign-in lasts at most 60 days
const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
// Every change must come from our own page: same Origin, plus a header other websites cannot send without permission.
function sameSiteOnly(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('Origin');
  if (!origin || new URL(origin).host !== url.host || request.headers.get('X-Requested-With') !== 'gnh')
    fail(403, 'Request refused.');
}

const SUSPENDED = 'This account has been suspended. Please contact the organiser.';
const PHONE_TAKEN = 'This mobile number is already registered. Sign in with the email you used.';
const clientIp = request => request.headers.get('CF-Connecting-IP') || null;

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
  if (!out.success) {
    const codes = (out['error-codes'] || []).join(', ') || 'unknown';
    console.log('Turnstile rejected:', codes, 'hostname:', out.hostname);
    fail(403, 'The human check failed. Please reload the page and try again.', { codes });
  }
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

  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(env.MAIL_FROM || '');          // "Game N Huat <noreply@gamenhuat.com>"
  const from = m && m[1] ? { name: m[1], email: m[2] } : (m ? m[2] : String(env.MAIL_FROM || '').trim());
  try { await env.EMAIL.send({
    from,
    to: email,
    subject: `Your Beat the Banker code: ${code}`,
    text: `Your code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this code, you can ignore this email.\n\nGame N Huat · gamenhuat.com`,
    html: `<p>Your code is <b style="font-size:20px;letter-spacing:2px">${code}</b>. It expires in 10 minutes.</p>
           <p>If you did not ask for this code, you can ignore this email.</p><p>Game N Huat · gamenhuat.com</p>`,
  }); } catch (err) {
    const why = (err && (err.code || err.name)) || 'unknown';
    console.error('Email sending failed:', why, err && err.message);
    fail(502, `We could not send the code email just now. Please try again in a few minutes. (${why})`);
  }
}

/* ---------------- sign-up, sign-in and the one-phone rule ---------------- */

async function register(env, b, request, now) {
  const name = checkName(b.name), { email, key } = checkEmail(b.email), phone = checkPhone(b.phone);
  if (b.agree !== true) fail(400, 'Please tick the box to agree before registering.');
  await turnstile(env, b.turnstile, request);
  const taken = await env.DB.prepare('SELECT 1 FROM players WHERE email_key = ?').bind(key).first();
  if (taken) fail(409, 'Already registered. Sign in.');
  const phoneTaken = await env.DB.prepare('SELECT 1 FROM players WHERE phone = ?').bind(phone).first();
  if (phoneTaken) fail(409, PHONE_TAKEN);
  const invite = String(b.invite || '').trim().toUpperCase().slice(0, 12) || null;
  await sendCode(env, key, email, 'register', { name, email, phone, invite, consent_at: now, ip: clientIp(request) }, now);
  return json({ ok: true });
}

async function signin(env, b, request, now) {
  const { email, key } = checkEmail(b.email);
  await turnstile(env, b.turnstile, request);
  const player = await env.DB.prepare('SELECT id, email, suspended FROM players WHERE email_key = ?').bind(key).first();
  if (!player) fail(404, 'Email not registered.');
  if (player.suspended) fail(403, SUSPENDED, { suspended: true });
  await sendCode(env, key, player.email, 'signin', null, now);
  return json({ ok: true });
}

async function verify(env, b, request, now) {
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
    if (await env.DB.prepare('SELECT 1 FROM players WHERE phone = ?').bind(d.phone).first()) fail(409, PHONE_TAKEN);
    const inviter = d.invite ? await env.DB.prepare('SELECT id FROM players WHERE invite_code = ?').bind(d.invite).first() : null;
    const res = await env.DB.prepare(`INSERT INTO players (email_key, email, name, phone, consent_at, invite_code, invited_by, created_at, reg_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(key, d.email, d.name, d.phone, d.consent_at, await newInviteCode(env), inviter ? inviter.id : null, now, d.ip || null).run();
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
    env.DB.prepare('UPDATE players SET last_ip = ?, last_seen = ? WHERE id = ?').bind(clientIp(request), now, playerId),
    ...(otherPhone ? [audit(env, now, playerId, 'pause', 'signed in on another phone')] : []),
  ]);
  const res = json({ pausedUntil });
  res.headers.append('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  return res;
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
  const token = readCookie(request, COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, 'Please sign in.');
  const s = await env.DB.prepare(`SELECT s.*, p.name, p.invite_code, p.extra_tries, p.total_score, p.suspended FROM sessions s
      JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!s) fail(401, 'You have been signed out. Please sign in again.', { signedOut: true });
  if (s.created_at + SESSION_DAYS * 86400_000 < Date.now()) fail(401, 'Your sign-in has expired. Please sign in again.', { signedOut: true });
  if (s.suspended) fail(403, SUSPENDED, { suspended: true });
  return s;
}

// Ends this phone's sign-in on the server. The account stays tied to this phone, so signing in
// here again has no pause, while signing in on another phone still triggers the 1-hour pause.
async function signout(env, request) {
  const token = readCookie(request, COOKIE);
  if (/^[a-f0-9]{64}$/.test(token))
    await env.DB.prepare('UPDATE sessions SET token_hash = ? WHERE token_hash = ?').bind('revoked:' + randomToken(), await sha256(token)).run();
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', sessionCookie('', 0));
  return res;
}

async function visit(env, s, b, request, now) {
  await turnstile(env, b.turnstile, request);
  await env.DB.batch([
    env.DB.prepare('UPDATE sessions SET verified_until = ? WHERE player_id = ?').bind(now + VISIT_MS, s.player_id),
    env.DB.prepare('UPDATE players SET last_ip = ?, last_seen = ? WHERE id = ?').bind(clientIp(request), now, s.player_id),
  ]);
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
  return { daily: Math.max(0, DAILY_TRIES - pd.daily_used), dailyTotal: DAILY_TRIES, extra: Math.max(0, extraUsable), extraBanked: s.extra_tries };
}

/* ---------------- cards ---------------- */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const rankOf = card => RANKS.indexOf(card.slice(0, -1)) + 1;     // A = 1 … K = 13

function drawThree() {                                           // a fresh 52-card deck every hand
  for (;;) {
    const deck = []; for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
    for (let i = deck.length - 1; i > deck.length - 4; i--) { const j = randomInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const [c1, c2, c3] = deck.slice(-3), b = bounds(c1, c2);
    if (b.high - b.low >= 2) return [c1, c2, c3];                 // no pairs or neighbours: there is always a card in between
  }
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
  const showdown = phase(env, h.day) === 'showdown';
  if (o.points < 0) {                                            // the score never goes below zero: lose only what you have
    const cur = showdown
      ? await env.DB.prepare('SELECT total_score AS v FROM players WHERE id = ?').bind(s.player_id).first()
      : await env.DB.prepare('SELECT score AS v FROM player_days WHERE player_id = ? AND day = ?').bind(s.player_id, h.day).first();
    o.points = -Math.min(BET, cur ? cur.v : 0);
  }
  const claim = await env.DB.prepare(`UPDATE hands SET status = 'done', choice = ?, result = ?, points = ?, decided_at = ?
      WHERE id = ? AND status = 'open'`).bind(choice, o.result, o.points, now, h.id).run();
  if (!claim.meta.changes) {
    const again = await env.DB.prepare('SELECT * FROM hands WHERE id = ?').bind(h.id).first();
    return reveal(again);
  }
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

const shortName = n => { const t = String(n).trim(); return [...t].length > 4 ? [...t].slice(0, 4).join('') + '*****' : t; };  // "Tan Ah Kow" → "Tan *****"

async function rebuildLeaderboard(env, now) {
  const day = dayOf(now), board = phase(env, day) === 'showdown' ? 'showdown' : 'daily';
  const rows = board === 'showdown'
    ? await env.DB.prepare('SELECT name, total_score AS score FROM players WHERE total_score > 0 AND suspended = 0 ORDER BY total_score DESC, id LIMIT 50').all()
    : await env.DB.prepare(`SELECT p.name, d.score FROM player_days d JOIN players p ON p.id = d.player_id
        WHERE d.day = ? AND d.score > 0 AND p.suspended = 0 ORDER BY d.score DESC, d.player_id LIMIT 50`).bind(day).all();
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

/* ---------------- sponsors, prizes and pictures (what the game page shows) ---------------- */

const mediaUrl = key => key ? '/media/' + encodeURIComponent(key) : null;

async function content(env, request, now, ctx) {
  const cache = caches.default, cacheKey = new Request(new URL('/api/content', request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const day = dayOf(now);
  const sp = await env.DB.prepare(`SELECT * FROM sponsors WHERE active = 1 AND (start_day IS NULL OR start_day = '' OR start_day <= ?)
      AND (end_day IS NULL OR end_day = '' OR end_day >= ?) ORDER BY sort, id`).bind(day, day).all();
  const pr = await env.DB.prepare('SELECT * FROM prizes ORDER BY sort, id').all();
  const pick = r => ({ name: r.name, url: r.url });
  const res = new Response(JSON.stringify({
    banners: sp.results.filter(r => r.kind === 'banner' && r.image_key).map(r => ({ ...pick(r), image: mediaUrl(r.image_key) })),
    popups: sp.results.filter(r => r.kind === 'popup' && r.image_key).map(r => ({ ...pick(r), image: mediaUrl(r.image_key) })),
    logos: sp.results.filter(r => r.logo_key).map(r => ({ ...pick(r), logo: mediaUrl(r.logo_key) })),
    prizes: pr.results.map(r => ({ place: r.place, name: r.name, value: r.value, sponsor: r.sponsor, image: mediaUrl(r.image_key) })),
  }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' } });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));                // changes in the admin panel show within a minute
  return res;
}

async function media(env, url) {
  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  const obj = key && env.MEDIA ? await env.MEDIA.get(key) : null;
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}

/* ---------------- admin panel (admin.gamenhuat.com, behind Cloudflare Access) ---------------- */

let accessKeys = null, accessKeysAt = 0;
const b64url = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(t.length / 4) * 4, '=')), c => c.charCodeAt(0));

// Checks the sign-in token that Cloudflare Access attaches, so nobody can fake being an admin.
async function adminEmail(env, request, url, now) {
  if (!url.hostname.startsWith('admin.')) fail(404, 'Not found.');
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) fail(503, 'Admin sign-in is not set up yet (ACCESS_TEAM and ACCESS_AUD).');
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  const [h, p, sig] = jwt.split('.');
  if (!sig) fail(403, 'Please sign in to the admin panel.');
  if (!accessKeys || now - accessKeysAt > 3600_000) {
    const r = await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
    accessKeys = (await r.json()).keys; accessKeysAt = now;
  }
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const jwk = accessKeys.find(k => k.kid === header.kid);
  if (!jwk) fail(403, 'Please sign in to the admin panel.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(h + '.' + p));
  const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || claims.exp * 1000 < now) fail(403, 'Please sign in to the admin panel again.');
  const email = String(claims.email || '').toLowerCase();
  const allowed = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  if (!allowed.includes(email)) fail(403, 'This email is not an admin.');
  return email;
}

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const dayOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;

async function admin(env, request, url, now) {
  const who = await adminEmail(env, request, url, now);
  const p = url.pathname.slice('/api/admin/'.length), m = request.method, q = url.searchParams, day = dayOf(now);

  if (m === 'GET' && p === 'me') return json({ email: who, day, phase: phase(env, day) });

  if (m === 'GET' && p === 'players') {
    const term = clean(q.get('q'), 80), like = '%' + term + '%', offset = Math.max(0, Number(q.get('offset')) || 0);
    const rows = await env.DB.prepare(`SELECT p.id, p.name, p.email, p.phone, p.suspended, p.reg_ip, p.last_ip, p.last_seen, p.created_at, p.total_score, p.extra_tries,
        (SELECT score FROM player_days WHERE player_id = p.id AND day = ?) AS today,
        (SELECT COUNT(*) FROM devices WHERE player_id = p.id) AS phones,
        (SELECT COUNT(*) FROM audit WHERE player_id = p.id AND kind = 'pause') AS pauses,
        (SELECT name FROM players i WHERE i.id = p.invited_by) AS invited_by
      FROM players p WHERE (? = '' OR p.name LIKE ? OR p.email LIKE ? OR p.phone LIKE ? OR p.last_ip LIKE ? OR p.reg_ip LIKE ?)
      ORDER BY p.id DESC LIMIT 100 OFFSET ?`).bind(day, term, like, like, like, like, like, offset).all();
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first();
    return json({ total: total.n, rows: rows.results });
  }

  if (m === 'POST' && p === 'player') {                         // admins may change the name and the mobile number
    const b = await body(request), id = Number(b.id);
    const player = await env.DB.prepare('SELECT id, name, phone FROM players WHERE id = ?').bind(id).first();
    if (!player) fail(404, 'Player not found.');
    const batch = [];
    let phone = player.phone, name = player.name;
    if (b.phone !== undefined) {
      phone = checkPhone(b.phone);
      if (await env.DB.prepare('SELECT 1 FROM players WHERE phone = ? AND id != ?').bind(phone, id).first()) fail(409, 'Another player already has this mobile number.');
      if (phone !== player.phone) batch.push(audit(env, now, id, 'admin_phone', `${player.phone} → ${phone} by ${who}`));
    }
    if (b.name !== undefined) {
      name = checkName(b.name);
      if (name !== player.name) batch.push(audit(env, now, id, 'admin_name', `${player.name} → ${name} by ${who}`));
    }
    batch.unshift(env.DB.prepare('UPDATE players SET phone = ?, name = ? WHERE id = ?').bind(phone, name, id));
    await env.DB.batch(batch);
    return json({ ok: true, phone, name });
  }

  if (m === 'POST' && p === 'player/suspend') {                 // a suspended player is signed out, cannot sign in and leaves the leaderboard
    const b = await body(request), id = Number(b.id), on = b.suspended ? 1 : 0;
    const batch = [env.DB.prepare('UPDATE players SET suspended = ? WHERE id = ?').bind(on, id),
      audit(env, now, id, on ? 'admin_suspend' : 'admin_unsuspend', 'by ' + who)];
    if (on) batch.push(env.DB.prepare('UPDATE sessions SET token_hash = ? WHERE player_id = ?').bind('revoked:' + randomToken(), id));
    await env.DB.batch(batch);
    return json({ ok: true, suspended: !!on });
  }

  if (m === 'POST' && p === 'player/reset') {                   // clears the sign-in and any pause, so the player can sign in again
    const b = await body(request), id = Number(b.id);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE player_id = ?').bind(id),
      audit(env, now, id, 'admin_reset', 'by ' + who),
    ]);
    return json({ ok: true });
  }

  if (m === 'GET' && p === 'leaderboard') {
    const board = q.get('board') === 'showdown' ? 'showdown' : 'daily';
    const rows = board === 'showdown'
      ? await env.DB.prepare('SELECT id, name, email, phone, total_score AS score FROM players WHERE total_score > 0 ORDER BY total_score DESC, id LIMIT 100').all()
      : await env.DB.prepare(`SELECT p.id, p.name, p.email, p.phone, d.score FROM player_days d JOIN players p ON p.id = d.player_id
          WHERE d.day = ? AND d.score > 0 ORDER BY d.score DESC, d.player_id LIMIT 100`).bind(clean(q.get('day'), 10) || day).all();
    return json({ board, day: clean(q.get('day'), 10) || day, rows: rows.results });
  }

  if (m === 'GET' && p === 'lockouts') {
    const rows = await env.DB.prepare(`SELECT p.id, p.name, p.email, p.phone, p.last_ip, COUNT(*) AS pauses, MAX(a.at) AS last_at,
        (SELECT COUNT(*) FROM devices WHERE player_id = p.id) AS phones
      FROM audit a JOIN players p ON p.id = a.player_id WHERE a.kind = 'pause' GROUP BY p.id ORDER BY last_at DESC LIMIT 500`).all();
    return json({ rows: rows.results });
  }

  if (p === 'media') {
    if (!env.MEDIA) fail(503, 'Picture storage (R2 bucket) is not connected.');
    if (m === 'GET') return json({ rows: (await env.DB.prepare('SELECT * FROM media ORDER BY uploaded_at DESC').all()).results.map(r => ({ ...r, url: mediaUrl(r.key) })) });
    if (m === 'POST') {
      const type = (request.headers.get('content-type') || '').split(';')[0];
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) fail(400, 'Please upload a PNG, JPG, WebP or GIF picture.');
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 5 * 1024 * 1024) fail(400, 'Pictures must be 5 MB or smaller.');
      const name = clean(q.get('name'), 120) || 'picture';
      const key = now.toString(36) + '-' + name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
      await env.DB.prepare('INSERT INTO media (key, name, type, size, uploaded_at) VALUES (?, ?, ?, ?, ?)').bind(key, name, type, bytes.byteLength, now).run();
      return json({ key, url: mediaUrl(key) });
    }
    if (m === 'DELETE') {
      const key = clean(q.get('key'), 200);
      await env.MEDIA.delete(key);
      await env.DB.prepare('DELETE FROM media WHERE key = ?').bind(key).run();
      return json({ ok: true });
    }
  }

  if (p === 'sponsors') {
    if (m === 'GET') return json({ rows: (await env.DB.prepare('SELECT * FROM sponsors ORDER BY kind, sort, id').all()).results });
    if (m === 'POST') {
      const b = await body(request);
      const kind = b.kind === 'popup' ? 'popup' : 'banner';
      const v = [clean(b.name, 80), clean(b.url, 300), kind, clean(b.image_key) || null, clean(b.logo_key) || null, b.active ? 1 : 0,
        dayOrNull(b.start_day), dayOrNull(b.end_day), Number(b.sort) || 0];
      if (!v[0]) fail(400, 'Please enter the sponsor name.');
      if (v[1] && !/^https:\/\//.test(v[1])) fail(400, 'The link must start with https://');
      if (b.id) await env.DB.prepare(`UPDATE sponsors SET name = ?, url = ?, kind = ?, image_key = ?, logo_key = ?, active = ?, start_day = ?, end_day = ?, sort = ? WHERE id = ?`).bind(...v, Number(b.id)).run();
      else await env.DB.prepare(`INSERT INTO sponsors (name, url, kind, image_key, logo_key, active, start_day, end_day, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...v, now).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM sponsors WHERE id = ?').bind(Number(q.get('id'))).run(); return json({ ok: true }); }
  }

  if (p === 'prizes') {
    if (m === 'GET') return json({ rows: (await env.DB.prepare('SELECT * FROM prizes ORDER BY sort, id').all()).results });
    if (m === 'POST') {
      const b = await body(request);
      const v = [clean(b.place, 40), clean(b.name, 80), clean(b.value, 40), clean(b.sponsor, 80), clean(b.image_key) || null, Number(b.sort) || 0];
      if (!v[0] || !v[1]) fail(400, 'Please enter the place and the prize name.');
      if (b.id) await env.DB.prepare('UPDATE prizes SET place = ?, name = ?, value = ?, sponsor = ?, image_key = ?, sort = ? WHERE id = ?').bind(...v, Number(b.id)).run();
      else await env.DB.prepare('INSERT INTO prizes (place, name, value, sponsor, image_key, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(...v, now).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM prizes WHERE id = ?').bind(Number(q.get('id'))).run(); return json({ ok: true }); }
  }

  if (p === 'pot') {
    if (m === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM days ORDER BY day DESC LIMIT 40').all();
      const players = await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first();
      const yesterday = dayOf(now - 86400_000);
      const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM player_days WHERE day = ? AND hands > 0').bind(yesterday).first();
      // Suggestion: about 15 points per registered player, as in the planning simulations.
      return json({ today: day, defaultPot: Number(env.POT_DEFAULT), players: players.n, activeYesterday: active.n,
        suggested: Math.max(100_000, Math.round(players.n * 15 / 1000) * 1000), rows: rows.results });
    }
    if (m === 'POST') {
      const b = await body(request), d = dayOrNull(b.day), amount = Math.round(Number(b.pot_start) / 100) * 100;
      if (!d || !(amount >= 0)) fail(400, 'Please enter a date and an amount.');
      await env.DB.prepare('INSERT INTO days (day, pot_start, pot_paid) VALUES (?, ?, 0) ON CONFLICT(day) DO UPDATE SET pot_start = excluded.pot_start').bind(d, amount).run();
      return json({ ok: true });
    }
  }
  fail(404, 'Not found.');
}

// Exported for tests.
export const _test = { bounds, outcome, checkEmail, checkPhone, dayOf, shortName, drawThree };
