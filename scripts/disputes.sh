#!/bin/zsh
# List disputed AI grades from the live database. Usage: scripts/disputes.sh [open|all] [limit]
# After acting on one (fixing the card, the grader prompt, or deciding no change), mark it:
#   wrangler d1 execute hill-speak --remote --command "UPDATE disputes SET status = 'done' WHERE id = N"
set -e
cd "$(dirname "$0")/.."
filter=$([ "${1:-open}" = "all" ] && echo "1=1" || echo "status = 'open'")
wrangler d1 execute hill-speak --remote --json --command "SELECT id, datetime(created_at/1000, 'unixepoch') AS at, course, card, question, response, note, outcome, json_extract(first_json, '$.percent') AS first_pct, json_extract(regrade_json, '$.percent') AS regrade_pct, json_extract(regrade_json, '$.reply') AS reply, status FROM disputes WHERE $filter ORDER BY id DESC LIMIT ${2:-50}" \
  | python3 scripts/format_disputes.py
