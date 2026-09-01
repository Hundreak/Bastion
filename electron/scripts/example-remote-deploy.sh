#!/usr/bin/env bash
#
# Worked example of a remote deploy script.
#
# The console uploads this file and a tarball of the local build, then runs:
#
#     bash <this script> <archive> <app-root>
#
# What it demonstrates is the part worth copying: an atomic release swap, so the
# site is never serving a half-extracted directory, and a rollback that restores
# the previous release if the health check does not pass. Adapt the service
# names and health check to your own deployment.
set -Eeuo pipefail

ARCHIVE="${1:?archive path required}"
APP_ROOT="${2:?application root required}"

RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
SHARED="$APP_ROOT/shared"
DEPLOY_ID="$(date +%Y%m%d-%H%M%S)"
RELEASE_DIR="$RELEASES/$DEPLOY_ID"
KEEP_RELEASES=5

# Files that belong to the server, not to the build. They are captured from the
# live release and restored into the new one: a deploy that overwrites a
# production .env with whatever happened to be in the developer's tree is the
# single most common way to take a site down.
PRESERVE=("\.env" "\.env\.local")

say() { printf '%s\n' "$*"; }

rollback() {
  local previous="$1"
  if [[ -n "$previous" && -d "$previous" ]]; then
    say "ROLLBACK: restoring $previous"
    ln -sfn "$previous" "$CURRENT.tmp" && mv -Tf "$CURRENT.tmp" "$CURRENT"
    say "ROLLBACK: done"
  else
    say "ROLLBACK: no previous release to restore"
  fi
}

PREVIOUS_TARGET=""
[[ -L "$CURRENT" ]] && PREVIOUS_TARGET="$(readlink -f "$CURRENT" || true)"

trap 'say "FAILED at line $LINENO"; rollback "$PREVIOUS_TARGET"; exit 1' ERR

say "STEP: prepare"
mkdir -p "$RELEASES" "$SHARED" "$RELEASE_DIR"

say "STEP: extract"
tar -xzf "$ARCHIVE" -C "$RELEASE_DIR"
rm -f "$ARCHIVE"

say "STEP: preserve server-owned files"
if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
  for rel in "${PRESERVE[@]}"; do
    src="$PREVIOUS_TARGET/$rel"
    if [[ -f "$src" ]]; then
      mkdir -p "$(dirname "$RELEASE_DIR/$rel")"
      cp -a "$src" "$RELEASE_DIR/$rel"
      say "  kept $rel from the previous release"
    fi
  done
fi

say "STEP: swap"
# ln -sfn onto an existing symlink is not atomic; writing a temporary link and
# renaming it is. The difference is a window in which the web server can see no
# document root at all.
ln -sfn "$RELEASE_DIR" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"

say "STEP: reload"
if command -v nginx >/dev/null 2>&1; then
  nginx -t
  systemctl reload nginx
fi

say "STEP: health"
# Replace with a check that actually proves the application answers. A deploy
# whose health check cannot fail is a deploy with no rollback.
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 10 http://127.0.0.1/ >/dev/null || {
    say "health check failed"
    exit 1
  }
fi

say "STEP: prune"
if [[ -d "$RELEASES" ]]; then
  # shellcheck disable=SC2012
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
    [[ "$(readlink -f "$old")" == "$(readlink -f "$CURRENT")" ]] && continue
    rm -rf "$old"
    say "  pruned $(basename "$old")"
  done
fi

trap - ERR
say "DONE: $DEPLOY_ID"
