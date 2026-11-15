# Base image pinned by digest (node 22.23.5 alpine, pulled 2026-11-15)
FROM node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /srv/thermostat
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
COPY app ./app
ENV NODE_ENV=production DATA_DIR=/data
USER node
EXPOSE 8890 3001
CMD ["node", "app/server.js"]
