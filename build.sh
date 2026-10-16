#!/bin/zsh
# Wrap the vault's artifact source in a full HTML document for static hosting.
set -e
cd "$(dirname "$0")"
SRC="$HOME/Documents/Obsidian Vault/05_Reference/Hill Speak/hill-speak.html"  # moved out of 00_Inbox 2026-10-09
{
  echo '<!doctype html>'
  echo '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  echo '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}*,*::before,*::after{box-sizing:border-box}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>'
  echo '</head><body>'
  cat "$SRC"
  echo '</body></html>'
} > docs/index.html
