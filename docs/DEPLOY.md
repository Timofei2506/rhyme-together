# Деплой RHYME TOGETHER

## Почему не «просто Vercel»

Игровая логика требует **постоянного WebSocket-соединения** (комната, серверное время,
сигналинг WebRTC). Serverless-функции Vercel живут секунды и не держат сокеты,
поэтому деплой делится на две части:

| Часть | Куда | Что это |
|---|---|---|
| Фронтенд (`src/`) | Vercel — статика | HTML/CSS/JS, партитуры JSON |
| Игровой сервер (`server/`) | Railway / Render / Fly.io / VPS | Node.js + `ws` + WebRTC-сигналинг |

`vercel.json` уже настроен на выдачу папки `src` как статики.

## Шаг 1. Игровой сервер

```bash
# Railway / Render / Fly.io: команда запуска
npm install && node server/index.js

# обязательные переменные
PORT=3000
TURN_URL=turn:your-turn-host:3478?transport=udp,turns:your-turn-host:5349
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Получите публичный HTTPS-адрес сервера, например `https://rhyme-api.up.railway.app`.

## Шаг 2. Фронтенд на Vercel

В `src/js/app.js` сетевой клиент подключается к тому же origin (`/ws`).
Если фронтенд и сервер на разных доменах — задайте адрес API в `src/js/config.js`
и проксируйте через `rewrites` в `vercel.json`:

```json
{ "rewrites": [{ "source": "/ws", "destination": "https://rhyme-api.up.railway.app/ws" }] }
```

> Проксирование WebSocket через rewrites Vercel не поддерживается для апгрейда
> соединения — надёжнее открыть фронтенд на том же домене, что и сервер
> (тогда `vercel.json` не нужен вовсе), либо указать в клиенте абсолютный `wss://` адрес.

## Шаг 3. TURN (для голоса через интернет)

STUN покрывает большинство домашних сетей. Для мобильных операторов и корпоративных
сетей нужен TURN:

```bash
# пример: coturn на VPS
apt install coturn
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=rhyme.example.com
user=rhyme:СЕКРЕТ
```
Затем задайте `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` на сервере приложения —
клиенты получат их через `/api/rtc-config`.

## Шаг 4. База данных

1. Выполните `docs/schema.sql` в PostgreSQL/Supabase.
2. Замените `server/store.js` на адаптер с теми же методами
   (`init`, `touchPlayer`, `recordResult`, `leaderboard`, `profile`, `stats`).

## Проверка после деплоя

```bash
BASE=https://ваш-домен npx playwright install chromium
BASE=https://ваш-домен node tools/e2e.js
```
