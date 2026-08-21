#!/bin/sh
# Restart the game server and vite without killing the calling shell.
# (A bare `pkill -f tsx` matches this script's own command line.)
cd /home/user/blind-spot
if [ -f /tmp/bs-server.pid ]; then kill "$(cat /tmp/bs-server.pid)" 2>/dev/null; fi
if [ -f /tmp/bs-vite.pid ]; then kill "$(cat /tmp/bs-vite.pid)" 2>/dev/null; fi
sleep 1
BS_ROOM_SEED=${BS_ROOM_SEED:-7} nohup npx tsx src/server/index.ts > /tmp/server.log 2>&1 &
echo $! > /tmp/bs-server.pid
nohup npx vite --port 5173 --host > /tmp/vite.log 2>&1 &
echo $! > /tmp/bs-vite.pid
sleep 4
curl -sf http://localhost:8787/healthz >/dev/null && echo "server up" || echo "SERVER DOWN"
curl -sf http://localhost:5173/ -o /dev/null && echo "vite up" || echo "VITE DOWN"
