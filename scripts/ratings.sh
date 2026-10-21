#!/bin/zsh
# Tester-mode ratings per card, furthest from the target first (useful 5/5, level 3/5 = about right), with comments.
# Usage: scripts/ratings.sh [limit]
set -e
cd "$(dirname "$0")/.."
wrangler d1 execute hill-speak --remote --json --command "SELECT course, card, MAX(question) AS question, COUNT(*) AS n, ROUND(AVG(useful), 1) AS useful, ROUND(AVG(level), 1) AS level, SUM(level <= 2) AS too_basic, SUM(level >= 4) AS too_hard, group_concat(CASE WHEN comment != '' THEN comment END, ' || ') AS comments FROM card_ratings GROUP BY course, card ORDER BY COALESCE(5 - AVG(useful), 0) + COALESCE(ABS(AVG(level) - 3), 0) DESC, n DESC LIMIT ${1:-50}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); rows=d[0]['results'] if isinstance(d,list) else d['results']
for r in rows:
  print(f\"[{r['course']}] {r['card']}  n={r['n']}  useful={r['useful']}  level={r['level']}  basic={r['too_basic']}  hard={r['too_hard']}\n  {r['question']}\" + (f\"\n  comments: {r['comments']}\" if r['comments'] else '') + '\n')"
echo '--- Session notes ---'
wrangler d1 execute hill-speak --remote --json --command "SELECT datetime(created_at/1000,'unixepoch') AS at, courses, comment FROM session_feedback WHERE done = 0 ORDER BY id DESC LIMIT 50" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); rows=d[0]['results'] if isinstance(d,list) else d['results']
[print(f\"{r['at']} [{r['courses']}] {r['comment']}\") for r in rows]"
