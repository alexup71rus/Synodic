#!/usr/bin/env bash
#
# Деплой SynodicServe на домашний сервер одной командой.
#
#   scripts/deploy.sh
#
# Что делает:
#   1. rsync'ит исходники (без node_modules/.git/logs) на сервер
#   2. ставит прод-зависимости (npm ci --omit=dev)
#   3. перезапускает процесс через nohup и делает health-check
#   4. запускает smoke-тест против задеплоенного сервера
#
# Цель можно переопределить переменными окружения:
#   SYNODIC_REMOTE=khdr@khodyr.netcraze.pro SYNODIC_DIR=Documents/Projects/SynodicServe PORT=8787
set -euo pipefail

REMOTE="${SYNODIC_REMOTE:-khdr@khodyr.netcraze.pro}"
DIR="${SYNODIC_DIR:-Documents/Projects/SynodicServe}"
PORT="${PORT:-8787}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ 1/4  rsync → ${REMOTE}:~/${DIR}"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude logs \
  "$ROOT/" "${REMOTE}:${DIR}/"

echo "→ 2/4  зависимости"
ssh "$REMOTE" "cd ~/$DIR && npm ci --omit=dev"

echo "→ 3/4  перезапуск"
ssh "$REMOTE" "cd ~/$DIR; mkdir -p logs; pkill -x synodic-serve 2>/dev/null || true; sleep 0.3; nohup env PORT=$PORT node src/index.js >> logs/server.log 2>&1 < /dev/null & echo '  pid:' \$!"

echo "→ health-check"
ssh "$REMOTE" "node -e 'fetch(\"http://127.0.0.1:$PORT/health\").then(r=>r.text()).then(t=>console.log(\"  \"+t)).catch(e=>{console.error(\"  FAIL:\",e.message);process.exit(1)})'"

echo "→ 4/4  smoke"
ssh "$REMOTE" "cd ~/$DIR && npm run smoke -- http://127.0.0.1:$PORT"
echo "✓ задеплоено, порт ${PORT}"
