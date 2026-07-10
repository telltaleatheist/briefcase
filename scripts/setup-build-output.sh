#!/usr/bin/env bash
#
# Point the electron-builder output dir (dist-electron) at an APFS location.
#
# Why: this working copy lives on exFAT, which stores extended attributes as
# `._` AppleDouble sidecars. Those break the code signature through Apple's
# notarization zip ("The signature of the binary is invalid"). APFS stores
# xattrs inline, so the packaged .app/DMG must be assembled there. The source
# can stay on exFAT. See docs/APFS-build-output.md.
#
# Idempotent and safe to re-run. macOS-only; a no-op elsewhere.

set -euo pipefail

# macOS only — other platforms have no exFAT/AppleDouble problem.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[setup-build-output] Not macOS — nothing to do."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINK="$REPO_ROOT/dist-electron"
TARGET="${BRIEFCASE_BUILD_DIR:-$HOME/Projects/Briefcase-builds/dist-electron}"

# If the repo already sits on APFS, redirection is unnecessary.
FS_TYPE="$(diskutil info "$(df "$REPO_ROOT" | tail -1 | awk '{print $1}')" 2>/dev/null \
  | awk -F': *' '/File System Personality/ {print $2}')"
if [[ "$FS_TYPE" == "APFS" ]]; then
  echo "[setup-build-output] Repo is already on APFS — no redirect needed."
  exit 0
fi

mkdir -p "$TARGET"

# Already correctly linked? Done.
if [[ -L "$LINK" && "$(readlink "$LINK")" == "$TARGET" ]]; then
  echo "[setup-build-output] Already linked: dist-electron -> $TARGET"
  exit 0
fi

# Replace whatever is there (stale build dir or wrong link). dist-electron is
# git-ignored build output, so removing it is safe.
if [[ -e "$LINK" || -L "$LINK" ]]; then
  echo "[setup-build-output] Removing existing $LINK"
  rm -rf "$LINK"
fi

ln -s "$TARGET" "$LINK"
echo "[setup-build-output] Linked: dist-electron -> $TARGET (APFS)"
