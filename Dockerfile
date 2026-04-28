FROM node:22-alpine
# The platform spawns child apps by shelling out to the host's Docker
# daemon (see src/services/docker.js — `execFile('docker', [...])`).
# That needs the docker CLI inside the container; the daemon itself
# is reached via a bind-mounted /var/run/docker.sock from the host.
# git is for the import-existing flow's `git clone` of foreign repos.
RUN apk add --no-cache docker-cli git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
