#!/bin/sh
# Waits for the dev server to actually answer, then opens it in the user's browser.
# Never fatal on the "open" part: if there is nothing to open with, print the URL and exit 0.
set -u
URL="${1:-http://localhost:5173}"
DEADLINE=$(( $(date +%s) + 120 ))

probe() {
  if command -v curl >/dev/null 2>&1; then curl -fs -o /dev/null --max-time 2 "$URL"
  elif command -v wget >/dev/null 2>&1; then wget -q -T 2 -O /dev/null "$URL"
  else return 2
  fi
}

printf 'waiting for %s ' "$URL"
while :; do
  probe && break
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "(no curl/wget here — skipping the readiness check)"
    break
  fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "timeout"; exit 1; }
  printf '.'
  sleep 1
done
echo " ready"

open_url() {
  if   command -v xdg-open  >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open      >/dev/null 2>&1; then open "$URL"
  elif command -v wslview   >/dev/null 2>&1; then wslview "$URL"
  elif command -v powershell.exe >/dev/null 2>&1; then powershell.exe -NoProfile Start-Process "$URL"
  elif command -v cmd.exe   >/dev/null 2>&1; then cmd.exe /c start "" "$URL"
  elif command -v start     >/dev/null 2>&1; then start "$URL"
  else return 1
  fi
}

if open_url >/dev/null 2>&1; then
  echo "opened $URL"
else
  echo "could not open a browser automatically — open this yourself: $URL"
fi
exit 0
