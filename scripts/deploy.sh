#!/usr/bin/env bash
#
# Деплой SynodicServe на домашний сервер одной командой.
#
#   scripts/deploy.sh
#
# Что делает:
#   1. rsync'ит исходники (без node_modules/.git/logs) на сервер
#   2. ставит прод-зависимости (npm ci --omit=dev)
#   3. устанавливает/перезапускает user-systemd unit
#   4. делает health-check
#   5. запускает smoke-тест против задеплоенного сервера
#
# Цель можно переопределить переменными окружения:
#   SYNODIC_REMOTE=khdr@khodyr.netcraze.pro SYNODIC_DIR=Documents/Projects/SynodicServe PORT=8787
set -euo pipefail

REMOTE="${SYNODIC_REMOTE:-khdr@khodyr.netcraze.pro}"
DIR="${SYNODIC_DIR:-Documents/Projects/SynodicServe}"
PORT="${PORT:-8787}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ 1/5  rsync → ${REMOTE}:~/${DIR}"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude logs \
  "$ROOT/" "${REMOTE}:${DIR}/"

echo "→ 2/5  зависимости"
ssh "$REMOTE" "cd ~/$DIR && npm ci --omit=dev"

echo "→ 3/5  user-systemd"
ssh "$REMOTE" "cd ~/$DIR && scripts/install-user-service.sh '$DIR' '$PORT'"

echo "→ 4/5  health-check"
ssh "$REMOTE" "node -e 'const url=\"http://127.0.0.1:$PORT/health\";let left=10;(async()=>{while(left--){try{const r=await fetch(url);if(r.ok){console.log(\"  \"+await r.text());return}}catch{}await new Promise(r=>setTimeout(r,500))}console.error(\"  FAIL: health-check timeout\");process.exit(1)})()'"

echo "→ 5/5  smoke"
ssh "$REMOTE" "cd ~/$DIR && npm run smoke -- http://127.0.0.1:$PORT"
echo "✓ задеплоено, порт ${PORT}"
