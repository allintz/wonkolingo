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
