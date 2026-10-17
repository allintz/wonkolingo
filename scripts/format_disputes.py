# Formats `wrangler d1 execute --json` output from scripts/disputes.sh.
import json, sys
rows = json.load(sys.stdin)[0]['results']
if not rows:
    print('No disputes.')
for r in rows:
    print(f"#{r['id']} {r['at']} [{r['status']}] {r['course']} {r['card']}")
    print(f"  Q: {r['question']}\n  A: {r['response']}\n  Why disputed: {r['note'] or '(none)'}")
    print(f"  {r['first_pct']}% -> {r['regrade_pct']}% ({r['outcome']})\n  Opus: {r['reply']}\n")
