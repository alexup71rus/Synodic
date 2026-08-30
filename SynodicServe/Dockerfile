# SynodicServe: сервер комнат + статика фронтенда (public/ кладёт deploy.sh)
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/index.js"]
