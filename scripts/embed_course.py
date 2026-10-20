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
s = s[:m.start()] + 'const ' + var + ' = ' + body + ';\n' + s[m.end():]
open(page, 'w').write(s)
n = sum(len(l['items']) for u in units for l in u['lessons'])
print(f'embedded {var}: {len(units)} units, {sum(len(u["lessons"]) for u in units)} lessons, {n} cards')
