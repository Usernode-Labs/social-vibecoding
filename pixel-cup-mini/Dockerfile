# Multi-stage build: install full deps + build the client bundle in the
# builder stage, then ship only production deps + the built artifact.
#
# The default Usernode scaffold is `npm ci --production`, but this app
# needs dev dependencies (esbuild, phaser, typescript) to produce
# public/game.bundle.js, so we build then prune.

# --- builder ---------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime ---------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
# Bring over app source + the freshly built bundle from the builder.
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/dapp.json ./dapp.json
EXPOSE 3000
CMD ["node", "server.js"]
