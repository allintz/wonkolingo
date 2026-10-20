# Formats scripts/removals.sh output (wrangler d1 --json) for reading.
import collections, json, sys

rows = json.load(sys.stdin)[0]["results"]
if not rows:
    print("No removals yet.")
for r in rows:
    why = collections.Counter((r["reasons"] or "").split(",")) if r["reasons"] else {}
    print(f'{r["removed"]}x removed, {r["restored"]}x restored  {r["course"]}  {r["card"]}  (last {r["last"]})')
    if why:
        print("   " + ", ".join(f"{k} {v}" for k, v in why.items()))
    print("   " + (r["question"] or "")[:200])
