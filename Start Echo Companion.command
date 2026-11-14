#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  print "Node.js 18.20 or newer is needed to start Echo Companion."
  read "?Press Return to close."
  exit 1
fi
if /usr/bin/curl --silent --fail http://127.0.0.1:4320/api/pair-status >/dev/null; then
  /usr/bin/open http://127.0.0.1:4320
  exit 0
fi
if [ ! -d node_modules/alexa-remote2 ]; then
  npm install --cache .npm-cache --no-audit --no-fund --ignore-scripts || exit 1
fi
( for attempt in {1..30}; do
    if /usr/bin/curl --silent --fail http://127.0.0.1:4320/api/pair-status >/dev/null; then
      /usr/bin/open http://127.0.0.1:4320
      exit 0
    fi
    sleep 1
  done ) &
node server.mjs
