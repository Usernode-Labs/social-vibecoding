FROM node:22-alpine

RUN apk add --no-cache docker-cli git

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
