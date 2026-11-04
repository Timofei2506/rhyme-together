# RHYME TOGETHER — игровой сервер (Node.js + WebSocket)
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server/ ./server/
COPY src/ ./src/
COPY tools/gen-songs.py ./tools/gen-songs.py
RUN mkdir -p /app/data

ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "server/index.js"]
