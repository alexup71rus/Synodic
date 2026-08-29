#!/usr/bin/env bash
# Устанавливает и запускает user-systemd unit на целевом сервере.
set -euo pipefail

DIR="${1:-Documents/Projects/SynodicServe}"
PORT="${2:-8787}"
PROJECT_DIR="$HOME/$DIR"
TEMPLATE="$PROJECT_DIR/systemd/synodic-serve.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/synodic-serve.service"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Некорректный PORT: $PORT" >&2
  exit 1
fi
if [[ "$(loginctl show-user "$USER" -p Linger --value)" != "yes" ]]; then
  echo "Для автозапуска после reboot выполните: loginctl enable-linger $USER" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
tmp_unit="$(mktemp "$UNIT_DIR/.synodic-serve.XXXXXX")"
trap 'rm -f "$tmp_unit"' EXIT

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

working_directory="$(escape_sed "$PROJECT_DIR")"
sed \
  -e "s|@WORKING_DIRECTORY@|$working_directory|g" \
  -e "s|@PORT@|$PORT|g" \
  "$TEMPLATE" > "$tmp_unit"
chmod 0644 "$tmp_unit"
mv "$tmp_unit" "$UNIT_FILE"
trap - EXIT

systemctl --user daemon-reload
systemctl --user stop synodic-serve.service 2>/dev/null || true
pkill -x synodic-serve 2>/dev/null || true # прибираем старый nohup-процесс
systemctl --user enable --now synodic-serve.service
systemctl --user is-active --quiet synodic-serve.service
