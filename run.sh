#!/usr/bin/env bash
# Launch the jev-voice-browser-zh server with the API key exported server-side.
# Usage: ./run.sh [--port 8787] [--host 127.0.0.1] [--headless] [--cdp ws://...] [--start-url https://...]
#
# The key is read from the TYPESAFE_API_KEY environment variable, or from a local .env file
# (copy .env.example to .env). It is never sent to the control page in the browser.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${TYPESAFE_API_KEY:-}" ] && [ -z "${JEV_API_KEY:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -z "${TYPESAFE_API_KEY:-}" ] && [ -z "${JEV_API_KEY:-}" ]; then
  echo "No API key found. Set TYPESAFE_API_KEY, or create .env from .env.example (get a key at https://console.typesafe.ai/keys)" >&2
  exit 1
fi

exec node src/server.js "$@"
