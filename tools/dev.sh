#!/bin/sh
# Restart the game server and vite without killing the calling shell.
# (A bare `pkill -f tsx` matches this script's own command line.)
cd /home/user/blind-spot
# Kill by PORT, not by name pattern: a bare `pkill -f tsx` also matches the shell
# that is running this script.
fuser -k -n tcp 8787 5173 >/dev/null 2>&1 || true
sleep 2
BS_ROOM_SEED=${BS_ROOM_SEED:-7} nohup npx tsx src/server/index.ts > /tmp/server.log 2>&1 &
echo $! > /tmp/bs-server.pid
nohup npx vite --port 5173 --host > /tmp/vite.log 2>&1 &
echo $! > /tmp/bs-vite.pid
sleep 4
curl -sf http://localhost:8787/healthz >/dev/null && echo "server up" || echo "SERVER DOWN"
curl -sf http://localhost:5173/ -o /dev/null && echo "vite up" || echo "VITE DOWN"
