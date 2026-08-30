#!/usr/bin/env bash
# Упаковывает готовое MV3-расширение без сборщика и внешних зависимостей.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/dist"
VERSION="$(cd "$ROOT" && node -p "require('./manifest.json').version")"
ARCHIVE="$DIST_DIR/synodic-ext-${VERSION}.zip"
UNPACKED="$DIST_DIR/synodic-ext-${VERSION}-unpacked"

node "$ROOT/scripts/configure.mjs"
mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE"

(
  cd "$ROOT"
  zip -qr "$ARCHIVE" manifest.json icons src \
    -x '*.DS_Store' '*/.DS_Store'
)
zip -qj "$ARCHIVE" "$ROOT/../LICENSE"

unzip -tq "$ARCHIVE"
STAGING_DIR="$(mktemp -d "$DIST_DIR/.synodic-ext-${VERSION}-unpacked.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
unzip -q "$ARCHIVE" -d "$STAGING_DIR"
rm -rf "$UNPACKED"
mv "$STAGING_DIR" "$UNPACKED"
trap - EXIT
echo "✓ пакет готов: $ARCHIVE"
echo "✓ распакованная версия: $UNPACKED"
