#!/usr/bin/env python3
"""Embed a built-in course's units into the page source.
Usage: python3 scripts/embed_course.py <VAR_NAME> <units-or-course.json> [<wonkolingo.html>]
Replaces the `const VAR_NAME = [ ... ];` block (e.g. TOOLS_UNITS, POLICY_UNITS) with the JSON's units."""
import json, re, sys, os

var, src = sys.argv[1], sys.argv[2]
page = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~/Documents/Obsidian Vault/05_Reference/WonkoLingo/wonkolingo.html')
d = json.load(open(src))
units = d['units'] if isinstance(d, dict) else d
body = json.dumps(units, indent=1, ensure_ascii=False).replace('</', '<\\/')
s = open(page).read()
m = re.search(r'^const ' + re.escape(var) + r' = \[\n.*?\n\];\n', s, flags=re.S | re.M)
if not m:
    sys.exit('block not found: ' + var)
new_block = 'const ' + var + ' = ' + body + ';\n'
changed = s[m.start():m.end()] != new_block
s = s[:m.start()] + new_block + s[m.end():]
# A real change moves the course's "updated" date (shown on its course page) to today.
if changed:
    import datetime
    today = datetime.date.today().isoformat()
    s, n = re.subn(r"(units: " + re.escape(var) + r", [^\n]*?updated: ')\d{4}-\d{2}-\d{2}(')", lambda mm: mm.group(1) + today + mm.group(2), s, count=1)
    if n: print(f'updated date for {var} set to {today}')
open(page, 'w').write(s)
n = sum(len(l['items']) for u in units for l in u['lessons'])
print(f'embedded {var}: {len(units)} units, {sum(len(u["lessons"]) for u in units)} lessons, {n} cards')
