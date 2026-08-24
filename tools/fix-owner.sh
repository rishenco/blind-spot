#!/bin/sh
# Safety net only. The containers that write into the repo run as the host uid:gid (see the
# `user:` key in docker-compose.yml), so normally there is nothing to fix here. This catches
# the leftovers of an older run that was made as root. Never a reason to fail the build.
set -u
[ "$(uname -s 2>/dev/null)" = "Linux" ] || exit 0
command -v id >/dev/null 2>&1 || exit 0
for d in "$@"; do
  [ -e "$d" ] && chown -R "$(id -u):$(id -g)" "$d" 2>/dev/null
done
exit 0
