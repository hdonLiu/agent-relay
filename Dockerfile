FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --workspace @agent-relay/server --omit=dev --ignore-scripts --no-audit --no-fund
COPY protocol.js ./
COPY server/ server/
USER node
EXPOSE 8787
CMD ["node", "server/index.js", "serve", "--host", "0.0.0.0", "--port", "8787"]
