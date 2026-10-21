#!/bin/zsh
# List errors the app reported (from its crash banner) in the live database. Usage: scripts/bugs.sh [open|all] [limit]
# After fixing one, mark it: wrangler d1 execute hill-speak --remote --command "UPDATE bug_reports SET done = 1 WHERE id = N"
set -e
cd "$(dirname "$0")/.."
filter=$([ "${1:-open}" = "all" ] && echo "1=1" || echo "done = 0")
wrangler d1 execute hill-speak --remote --json --command "SELECT id, datetime(created_at/1000, 'unixepoch') AS at, build, app, place, message, substr(stack, 1, 400) AS stack, ua FROM bug_reports WHERE $filter ORDER BY id DESC LIMIT ${2:-30}" \
  | python3 -c "import sys,json
rows=json.load(sys.stdin)[0]['results']
print(f'{len(rows)} report(s)')
for r in rows: print(f\"\\n#{r['id']} {r['at']} build {r['build']} {'iPhone app' if r['app'] else 'web'} at {r['place'] or 'Today'}\\n  {r['message']!r}\\n  {(r['stack'] or '')[:400]!r}\\n  {r['ua']!r}\")"
