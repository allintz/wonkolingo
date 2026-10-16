#!/bin/zsh
# Rebuild from the vault copy and deploy. Run `wrangler login` first if `wrangler whoami` fails.
set -e
cd "$(dirname "$0")"
./build.sh
wrangler deploy
