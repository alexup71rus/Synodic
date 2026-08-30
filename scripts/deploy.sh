#!/usr/bin/env bash
#
# Деплой Synodic на домашний сервер одной командой.
#
#   scripts/deploy.sh
#
# Что делает:
#   1. rsync'ит бэкенд (без node_modules/.git) и фронтенд ../SynodicWeb → public/
#   2. собирает и поднимает docker-стек (app + caddy) на сервере
#   3. прибирает старый user-systemd сервис synodic-serve (заменён docker'ом)
#   4. health-check и smoke-тест
#
# Цель можно переопределить переменными окружения:
#   SYNODIC_REMOTE=khdr@khodyr.netcraze.pro SYNODIC_DIR=Documents/Projects/SynodicServe
set -euo pipefail

REMOTE="${SYNODIC_REMOTE:-khdr@khodyr.netcraze.pro}"
DIR="${SYNODIC_DIR:-Documents/Projects/SynodicServe}"
WEB_DIR="${SYNODIC_WEB_DIR:-../SynodicWeb}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="$(cd "$ROOT/$WEB_DIR" && pwd)"

if [[ ! -f "$WEB_ROOT/index.html" ]]; then
  echo "Не найден фронтенд: $WEB_ROOT (SYNODIC_WEB_DIR)" >&2
  exit 1
fi

echo "→ 1/5  rsync бэкенд → ${REMOTE}:~/${DIR}"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude logs --exclude public \
  "$ROOT/" "${REMOTE}:${DIR}/"

echo "→ 2/5  rsync фронтенд → ${REMOTE}:~/${DIR}/public"
rsync -az --delete \
  --exclude .git --exclude .DS_Store \
  "$WEB_ROOT/" "${REMOTE}:${DIR}/public/"

echo "→ 3/5  docker-стек (app + caddy)"
ssh "$REMOTE" "cd ~/$DIR && docker compose up -d --build"

echo "→ 4/5  убрать старый user-systemd сервис"
ssh "$REMOTE" '
  if systemctl --user list-unit-files synodic-serve.service 2>/dev/null | grep -q synodic; then
    systemctl --user disable --now synodic-serve.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/synodic-serve.service"
    systemctl --user daemon-reload
    systemctl --user reset-failed 2>/dev/null || true
    pkill -x synodic-serve 2>/dev/null || true
    echo "  старый сервис остановлен и удалён"
  else
    echo "  старого сервиса нет — чисто"
  fi
'

echo "→ 5/5  health-check и smoke"
ssh "$REMOTE" "node -e 'const url=\"http://127.0.0.1:8787/health\";let left=20;(async()=>{while(left--){try{const r=await fetch(url);if(r.ok){console.log(\"  \"+await r.text());return}}catch{}await new Promise(r=>setTimeout(r,500))}console.error(\"  FAIL: health-check timeout\");process.exit(1)})()'"
ssh "$REMOTE" "cd ~/$DIR && npm ci --omit=dev >/dev/null && npm run smoke -- http://127.0.0.1:8787"
echo "✓ задеплоено: https://synodic.khodyr.netcraze.pro (app: localhost:8787)"
