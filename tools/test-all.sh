#!/bin/sh
# Full suite. Headless logic tests first (fast), then the browser tests.
cd /home/user/blind-spot
# (no set -e: every suite must run even if an earlier one fails)
fails=0
run() {
  printf '\n=== %s ===\n' "$1"
  shift
  if "$@"; then :; else fails=$((fails+1)); fi
}
run "raycaster"        npx tsx tools/test-raycast.ts
run "map"              npx tsx tools/test-map.ts
run "firewall (headless protocol)" npx tsx tools/test-firewall.ts
sh tools/dev.sh > /dev/null 2>&1
run "scan yield"       npx tsx tools/test-scan.ts
run "point dedup"      npx tsx tools/test-dedup.ts
run "movement"         npx tsx tools/test-move.ts
run "STALE INFORMATION ACCEPTANCE TEST" npx tsx tools/test-stale.ts
run "gameplay"         npx tsx tools/test-gameplay.ts
run "full match"       npx tsx tools/test-match.ts
run "soak"             npx tsx tools/test-soak.ts
printf '\n===================\n'
[ "$fails" -eq 0 ] && echo "ALL SUITES PASSED" || echo "$fails SUITE(S) FAILED"
exit "$fails"
