#!/usr/bin/env bash
# Публичный доступ к RHYME TOGETHER без карты и регистрации.
# Поднимает игровой сервер (если не запущен) и HTTPS-туннель Cloudflare,
# печатает ссылку, по которой можно играть вдвоём из разных сетей.
#
#   bash tools/serve.sh            # порт 3000, ссылка trycloudflare.com
#   PORT=8080 bash tools/serve.sh
set -euo pipefail
PORT="${PORT:-3000}"
cd "$(dirname "$0")/.."

# 1. зависимости
[ -d node_modules ] || npm install --omit=dev

# 2. сервер
if curl -sf -m 2 "http://localhost:${PORT}/api/health" >/dev/null; then
  echo "• сервер уже работает на :${PORT}"
else
  echo "• запускаю сервер на :${PORT}"
  HOST=0.0.0.0 PORT="${PORT}" RHYME_TOGETHER_DEBUG=1 nohup node server/index.js >/tmp/rhyme-server.log 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf -m 2 "http://localhost:${PORT}/api/health" >/dev/null && break
    sleep 0.5
  done
fi
curl -sf -m 3 "http://localhost:${PORT}/api/health" || { echo "сервер не поднялся, см. /tmp/rhyme-server.log"; exit 1; }

# 3. cloudflared
BIN=/tmp/cloudflared
if [ ! -x "$BIN" ]; then
  echo "• скачиваю cloudflared"
  curl -sL -o "$BIN" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$BIN"
fi

# 4. туннель
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
nohup "$BIN" tunnel --url "http://localhost:${PORT}" --no-autoupdate >/tmp/tunnel.log 2>&1 &

for _ in $(seq 1 40); do
  LINK=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/tunnel.log | head -1 || true)
  [ -n "${LINK:-}" ] && break
  sleep 1
done
[ -n "${LINK:-}" ] || { echo "не удалось получить ссылку, см. /tmp/tunnel.log"; exit 1; }

# 5. проверки
echo "• /api/health: $(curl -sf -m 10 "$LINK/api/health" || echo 'нет ответа')"
echo
echo "════════════════════════════════════════════════════"
echo "  ИГРАТЬ: $LINK"
echo "════════════════════════════════════════════════════"
echo "  Голос работает в современных браузерах: Android — Chrome,"
echo "  Windows — Chrome/Edge. Ссылка живёт, пока запущен туннель;"
echo "  после перезапуска адрес меняется — просто запустите скрипт снова."
