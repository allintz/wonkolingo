
-- Account-to-account friends, independent of legacy course groups.
CREATE TABLE IF NOT EXISTS friend_handles(player_id TEXT PRIMARY KEY REFERENCES players(id),handle TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS friendships(a TEXT NOT NULL,b TEXT NOT NULL,status TEXT NOT NULL,requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,accepted_at INTEGER,mute_a INTEGER NOT NULL DEFAULT 0,mute_b INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(a,b));
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(b);
CREATE TABLE IF NOT EXISTS friend_preferences(player_id TEXT PRIMARY KEY,requests INTEGER NOT NULL DEFAULT 1,streaks INTEGER NOT NULL DEFAULT 1,milestones INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS friend_rewards(a TEXT NOT NULL,b TEXT NOT NULL,player_id TEXT NOT NULL,kind TEXT NOT NULL,milestone INTEGER NOT NULL,xp INTEGER NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(a,b,player_id,kind,milestone));
CREATE INDEX IF NOT EXISTS idx_friend_rewards_player ON friend_rewards(player_id,created_at);
CREATE TABLE IF NOT EXISTS friend_days(a TEXT NOT NULL,b TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(a,b,day));
-- An email used for password sign-in stays private; those players choose a public username separately.
INSERT OR IGNORE INTO friend_handles(player_id,handle) SELECT player_id,username FROM passwords WHERE instr(username,'@')=0;
-- Existing explicitly accepted streak partners keep their connections. Other group members are suggestions only.
INSERT OR IGNORE INTO friendships(a,b,status,requested_by,created_at,accepted_at) SELECT a,b,'accepted',requested_by,created_at,created_at FROM friend_streaks f WHERE status='active' AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=f.a AND blocked_id=f.b) OR (player_id=f.b AND blocked_id=f.a));
CREATE TABLE IF NOT EXISTS course_libraries(player_id TEXT PRIMARY KEY,group_code TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS course_shares(course_id INTEGER PRIMARY KEY,token TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comp_player_day ON completions(player_id,day);

-- Preserve open legacy invitations without accepting a friendship on anyone’s behalf.
INSERT OR IGNORE INTO friendships(a,b,status,requested_by,created_at) SELECT a,b,'pending',requested_by,created_at FROM friend_streaks f WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=f.a AND blocked_id=f.b) OR (player_id=f.b AND blocked_id=f.a));
