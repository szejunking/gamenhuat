-- Game N Huat: database tables (run once in each D1 database's Console).

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_key     TEXT NOT NULL UNIQUE,      -- normalised email, used to stop duplicate accounts
  email         TEXT NOT NULL,             -- as typed, used for sending
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,             -- +60…, used only to contact winners
  consent_at    INTEGER NOT NULL,          -- when the tick box was agreed (ms)
  invite_code   TEXT NOT NULL UNIQUE,
  invited_by    INTEGER,                   -- players.id of the inviter
  extra_tries   INTEGER NOT NULL DEFAULT 0,-- earned from invites, carried forward
  total_score   INTEGER NOT NULL DEFAULT 0,-- showdown total
  created_at    INTEGER NOT NULL
);

-- Email codes for sign-up and for signing in on a new phone.
CREATE TABLE IF NOT EXISTS codes (
  email_key     TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL,             -- 'register' or 'signin'
  code_hash     TEXT NOT NULL,
  payload       TEXT,                      -- sign-up details waiting for the code
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sends         INTEGER NOT NULL DEFAULT 1,
  window_start  INTEGER NOT NULL,          -- start of the 1-hour send window
  last_sent_at  INTEGER NOT NULL
);

-- One session per player: the only phone allowed to play.
CREATE TABLE IF NOT EXISTS sessions (
  player_id     INTEGER PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  device_id     TEXT NOT NULL,
  paused_until  INTEGER NOT NULL DEFAULT 0,
  verified_until INTEGER NOT NULL DEFAULT 0, -- Turnstile passed on this visit until then
  created_at    INTEGER NOT NULL
);

-- Every phone an account has used, for spotting shared accounts.
CREATE TABLE IF NOT EXISTS devices (
  player_id     INTEGER NOT NULL,
  device_id     TEXT NOT NULL,
  first_seen    INTEGER NOT NULL,
  PRIMARY KEY (player_id, device_id)
);

-- One row per game day (Malaysia time): the banker's ang pow.
CREATE TABLE IF NOT EXISTS days (
  day           TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  pot_start     INTEGER NOT NULL,          -- set by admin, or the default
  pot_paid      INTEGER NOT NULL DEFAULT 0 -- points won by players minus points lost
);

-- Each player's tries and score for each day.
CREATE TABLE IF NOT EXISTS player_days (
  player_id     INTEGER NOT NULL,
  day           TEXT NOT NULL,
  daily_used    INTEGER NOT NULL DEFAULT 0,
  extra_used    INTEGER NOT NULL DEFAULT 0,
  score         INTEGER NOT NULL DEFAULT 0,
  hands         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);

CREATE TABLE IF NOT EXISTS hands (
  id            TEXT PRIMARY KEY,
  player_id     INTEGER NOT NULL,
  day           TEXT NOT NULL,
  c1            TEXT NOT NULL,             -- cards like 'AS', '10H', 'KD'
  c2            TEXT NOT NULL,
  c3            TEXT NOT NULL,             -- never sent to the phone before the choice
  low           INTEGER NOT NULL,
  high          INTEGER NOT NULL,
  try_kind      TEXT NOT NULL,             -- 'daily' or 'extra'
  status        TEXT NOT NULL DEFAULT 'open',
  choice        TEXT,                      -- 'go', 'skip' or 'auto'
  result        TEXT,                      -- 'between', 'match', 'outside', 'skip'
  points        INTEGER,
  deadline      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS hands_player_day ON hands (player_id, day);
CREATE INDEX IF NOT EXISTS hands_open ON hands (player_id, status);

CREATE TABLE IF NOT EXISTS leaderboard (
  board         TEXT NOT NULL,             -- 'daily' or 'showdown'
  rank          INTEGER NOT NULL,
  name          TEXT NOT NULL,
  score         INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (board, rank)
);

-- Log of sign-ups, new phones, pauses and other events worth reviewing.
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  player_id     INTEGER,
  kind          TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS audit_player ON audit (player_id);
