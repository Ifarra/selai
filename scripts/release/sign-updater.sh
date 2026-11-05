#!/usr/bin/env bash
# Signs the in-app updater packages with the minisign key in
# TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD), binding
# each signature to the app version. Runs after Authenticode signing and the
# macOS signature check, so every .sig matches the bytes that are published.
#
# Usage: scripts/release/sign-updater.sh <bundle-dir> <version>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <bundle-dir> <version>" >&2
  exit 2
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not set" >&2
  exit 1
fi
version=$2
repo=$(cd "$(dirname "$0")/../.." && pwd)
bundle=$(cd "$1" && pwd)
# The Tauri CLI is a native program; on Windows runners give it a Windows path.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

shopt -s nullglob
# The macOS updater package is the signed .app as a gzip tarball whose single
# top-level entry is Selai.app (the updater strips that first component).
# Built here rather than by `tauri build`, so the build never sees the key.
for app in "$bundle"/macos/*.app; do
  rm -f "$app.tar.gz"
  COPYFILE_DISABLE=1 tar -C "$(dirname "$app")" -czf "$app.tar.gz" "$(basename "$app")"
done
packages=(
  "$bundle"/nsis/*-setup.exe
  "$bundle"/msi/*.msi
  "$bundle"/appimage/*.AppImage
  "$bundle"/macos/*.app.tar.gz
)
if (( ${#packages[@]} == 0 )); then
  echo "no updater packages under $bundle" >&2
  exit 1
fi
for package in "${packages[@]}"; do
  rm -f "$package.sig"
  pnpm --dir "$repo/apps/desktop" --silent tauri signer sign --app-version "$version" "$(native "$package")" >/dev/null
  if [[ ! -s "$package.sig" ]]; then
    echo "no signature written for $package" >&2
    exit 1
  fi
  echo "signed $(basename "$package") for $version"
done
