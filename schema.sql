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
