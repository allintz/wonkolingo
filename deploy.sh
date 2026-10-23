#!/bin/zsh
# Rebuild from the vault copy, check it, deploy, then check the live site. Run `wrangler login` first if `wrangler whoami` fails.
set -e
cd "$(dirname "$0")"
./build.sh
# Nothing goes live unless the page's script parses, the unit tests pass, and the page starts cleanly on every route.
T=$(mktemp -t wl-app).js
node -e "const s=require('fs').readFileSync('docs/index.html','utf8');const m=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];require('fs').writeFileSync(process.argv[1],m)" "$T"
node --check "$T"; rm -f "$T"
for f in src/*.js; do node --check "$f"; done
node tests/unit.test.mjs
node tests/site-move.test.mjs
node scripts/lint_shared.mjs
node tests/tidy.test.mjs
node tests/catalog.test.mjs
node tests/smoke.mjs
wrangler deploy
(cd redirect && wrangler deploy)
node tests/live-smoke.mjs || { echo "The live site failed its check. Look before telling anyone it's up."; exit 1; }
