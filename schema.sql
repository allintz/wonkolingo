-- Group play: groups, players (token hashed), and one row per finished lesson.
CREATE TABLE IF NOT EXISTS groups (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  solo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  group_code TEXT NOT NULL REFERENCES groups(code),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL REFERENCES players(id),
  group_code TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  title TEXT NOT NULL,
  xp INTEGER NOT NULL,
  acc INTEGER NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comp_group ON completions(group_code, created_at);
CREATE INDEX IF NOT EXISTS idx_players_group ON players(group_code);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_code TEXT NOT NULL,
  slug TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_code, slug)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  player_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  item_text TEXT NOT NULL,
  note TEXT NOT NULL,
  version INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_course ON reports(course_id, resolved);
CREATE TABLE IF NOT EXISTS grade_usage (
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, player_id)
);
CREATE TABLE IF NOT EXISTS player_state (
  player_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Disputed AI grades: the player says the grader got it wrong, Opus re-grades, and the case is kept for course and grader fixes.
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  who TEXT NOT NULL,
  course TEXT NOT NULL,
  card TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  response TEXT NOT NULL,
  note TEXT NOT NULL,
  first_json TEXT NOT NULL,
  regrade_json TEXT,
  outcome TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at);
-- Accounts (2026-10-20). Every player has an account; a player who isn't in a group sits in a private one-person
-- "home" group (groups.solo = 1) that can't be joined, so players.group_code can stay NOT NULL.
-- On an existing database also run: ALTER TABLE groups ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
-- Extra signed-in devices: each has its own token secret (the players.key_hash token is the recovery code).
CREATE TABLE IF NOT EXISTS sessions (
  player_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, key_hash)
);
-- Passkeys (WebAuthn). id is the credential id (base64url); public_key is base64url COSE.
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkeys_player ON passkeys(player_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  player_id TEXT,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires INTEGER NOT NULL
);
-- Short codes for signing in on another device (single use, 10 minutes).
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
-- Players can block each other (App Store rule for user content): a blocked player's courses, scores and activity are hidden from the blocker.
CREATE TABLE IF NOT EXISTS blocks (
  player_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, blocked_id)
);
-- Questions players remove from their own reviews, with the reason they picked: feedback for fixing courses (scripts/removals.sh).
CREATE TABLE IF NOT EXISTS card_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  who TEXT NOT NULL,
  course TEXT NOT NULL,
  card TEXT NOT NULL,
  question TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_feedback_card ON card_feedback(card, created_at);
-- Optional username and password for an account (2026-10-20). PBKDF2-SHA256; usernames are stored lowercase and unique.
CREATE TABLE IF NOT EXISTS passwords (
  player_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Optional email per account, for sign-in codes and password resets (2026-10-21). Unique once verified.
CREATE TABLE IF NOT EXISTS emails (
  player_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL
);
-- Six-digit codes sent by email, stored hashed. kind: 'verify' (adding an email) or 'signin' (signing in, e.g. after a
-- forgotten password). A code dies after a few wrong tries.
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_codes_player ON email_codes(player_id, kind);
-- Errors the app hit, sent by the crash banner (2026-10-21): message, where, app version and browser, with no account
-- or progress data. Read with scripts/bugs.sh.
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  stack TEXT,
  place TEXT,
  build TEXT,
  app INTEGER NOT NULL DEFAULT 0,
  ua TEXT,
  created_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_open ON bug_reports(done, created_at);

-- The review page's "done" marks for items without their own status column (removed questions, by card id).
CREATE TABLE IF NOT EXISTS review_marks (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- Google and Apple accounts used to sign in (the provider's stable account id "sub"), one per provider per player.
CREATE TABLE IF NOT EXISTS sign_in_ids (
  provider TEXT NOT NULL,
  sub TEXT NOT NULL,
  player_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, sub)
);
CREATE INDEX IF NOT EXISTS sign_in_ids_player ON sign_in_ids (player_id);

-- Tester mode (2026-10-21): per-card ratings from players who turned it on in Me. useful 1-5 (target 5),
-- level 1-5 (1 too basic, 3 about right, 5 too hard), optional comment. One row per player per card; the latest tap wins.
CREATE TABLE IF NOT EXISTS card_ratings (
  who TEXT NOT NULL,
  course TEXT NOT NULL,
  card TEXT NOT NULL,
  question TEXT NOT NULL,
  useful INTEGER,
  level INTEGER,
  comment TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (who, card)
);
CREATE INDEX IF NOT EXISTS idx_card_ratings_card ON card_ratings(course, card);
-- Tester mode: the end-of-session "anything missing or off about this set?" note, with the session's courses and cards.
CREATE TABLE IF NOT EXISTS session_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  who TEXT NOT NULL,
  courses TEXT NOT NULL,
  cards TEXT NOT NULL,
  comment TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

-- Friend streaks between two players in the same group (a < b). Pending until the other accepts; counts from 'started'.
CREATE TABLE IF NOT EXISTS friend_streaks (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  started TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_fs_b ON friend_streaks(b);
-- Notifications for one player: nudges, high-fives, friend-streak requests and accepts. Kept 30 days.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_player ON notes(player_id, created_at);

-- iPhone push: one row per phone (APNs device token). sandbox = 1 for development builds installed from Xcode.
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  sandbox INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_player ON push_tokens(player_id);
