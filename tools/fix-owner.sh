#!/bin/sh
# The container writes into the bind mount as root; hand the results back to the host user.
# Only meaningful on Linux, and never a reason to fail the build.
set -u
[ "$(uname -s 2>/dev/null)" = "Linux" ] || exit 0
command -v id >/dev/null 2>&1 || exit 0
for d in "$@"; do
  [ -e "$d" ] && chown -R "$(id -u):$(id -g)" "$d" 2>/dev/null
done
exit 0
