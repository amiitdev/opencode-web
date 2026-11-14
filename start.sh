#!/usr/bin/env bash
# start.sh — launch the whole stack with one command.
#   1. OpenCode server  (the real agent, port 4321)
#   2. bridge.js        (browser <-> agent bridge, port 5175)

set -e

# 1. OpenCode server (skip if already up)
if curl -s -o /dev/null http://127.0.0.1:4321/doc; then
  echo "opencode server: already running on 4321"
else
  echo "starting opencode server on 4321…"
  nohup opencode web --port 4321 > /tmp/opencode-server.log 2>&1 &
  sleep 4
fi

# 2. Bridge (skip if already up)
if curl -s -o /dev/null http://127.0.0.1:5175/; then
  echo "bridge:           already running on 5175"
else
  echo "starting bridge on 5175…"
  nohup node "$(dirname "$0")/bridge.js" > /tmp/opencode-bridge.log 2>&1 &
  sleep 1
fi

echo
echo "✅ open http://127.0.0.1:5175/ in Chrome"
