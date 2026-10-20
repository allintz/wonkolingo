#!/bin/zsh
# Questions players removed from their reviews, most-removed first, with the reasons they picked.
# Usage: scripts/removals.sh [limit]   (restores are counted separately)
set -e
cd "$(dirname "$0")/.."
wrangler d1 execute hill-speak --remote --json --command "SELECT course, card, MAX(question) AS question, SUM(reason != 'restored') AS removed, SUM(reason = 'restored') AS restored, group_concat(CASE WHEN reason != 'restored' THEN reason END) AS reasons, datetime(MAX(created_at)/1000, 'unixepoch') AS last FROM card_feedback GROUP BY course, card ORDER BY removed DESC, last DESC LIMIT ${1:-50}" \
  | python3 scripts/format_removals.py
