-- Group play: groups, players (token hashed), and one row per finished lesson.
CREATE TABLE IF NOT EXISTS groups (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
