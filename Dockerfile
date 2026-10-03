# syntax=docker/dockerfile:1
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/build-web.ts ./scripts/
COPY src ./src
COPY test ./test
# The server into dist/src/, and the browser's app bundled into dist/web/ (ADR 0058).
RUN npm run build

# Holds the network namespace of the fixed-IPv6 layout (compose.ipv6.example.yaml) and sets the interface token.
# Only this image carries iproute2, and only its container gets NET_ADMIN. Built on the same base to share layers.
FROM node:24.12.0-bookworm-slim AS ipv6-netns
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 docker/ipv6-netns.sh /usr/local/bin/natsumi-ipv6-netns
ENTRYPOINT ["natsumi-ipv6-netns"]

# The runner of the workspace container (ADR 0011), built static so it depends on nothing in the image around it.
FROM golang:1.27 AS workspace-runner
WORKDIR /src
COPY runner/ ./
RUN go test ./... \
  && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/natsumi-workspace-runner .

# sdctl, which natsumi draws with (ADR 0044). Its releases carry no binary, so it is built from its source at a fixed
# version, static like the runner.
FROM golang:1.27 AS sdctl
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags='-s -w' github.com/yuanying/sdctl@v0.3.2

# natsumi's workspace (ADR 0019): an ordinary Debian environment with Python, and no network reaching it.
# There is no list of allowed commands any more; the confinement is the container's shape alone (compose.yaml).
# poppler-utils (pdftotext, pdftoppm) is for reading the PDFs taken in from Slack (ADR 0066); poppler-data holds the
# CJK character maps, without which a Japanese PDF gives no text and its pages render blank.
FROM debian:bookworm-slim AS workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash coreutils findutils diffutils grep sed gawk tar gzip ripgrep jq python3 git procps tzdata poppler-utils poppler-data \
  && rm -rf /var/lib/apt/lists/*
# A name for the default UID, and the mount points of the four writable places.
RUN groupadd --gid 1000 natsumi \
  && useradd --uid 1000 --gid 1000 --home-dir /home/natsumi --shell /bin/bash natsumi \
  && mkdir -p /memory /work /home/natsumi /run/natsumi-workspace \
  && chown natsumi:natsumi /work /home/natsumi
# Outside PATH, so running it by its path gives nothing bash does not already have.
COPY --from=workspace-runner /out/natsumi-workspace-runner /usr/libexec/natsumi-workspace-runner
# sdctl and its defaults (ADR 0044): the relay, /work/images and JPEG, baked in, so changing them is a new image. The
# params are the avatar's, which the server writes on every start and the workspace sees as /manual/avatar (ADR 0057).
# They are in a config file and not in ENV, because the runner gives natsumi's commands none of the image's environment
# (ADR 0019); the sdctl in PATH is a wrapper that always points the real one at that file. With these, `sdctl txt2img
# --prompt <file>` needs nothing else, and prints only the path it saved to.
COPY --from=sdctl /out/sdctl /usr/libexec/sdctl
COPY --chmod=755 docker/sdctl/sdctl /usr/local/bin/sdctl
COPY docker/sdctl/config.yaml /etc/sdctl/config.yaml
# sources-diff (ADR 0050): what changed under /sources, read from the history the server keeps in /sources.git, which
# is mounted read-only. The runner gives it none of the image's environment, so the script knows the place itself.
COPY --chmod=755 docker/sources-diff/sources-diff /usr/local/bin/sources-diff
# natsumi's manual (ADR 0036), read-only like the rest of the root. The list of agents the server writes on every
# start is mounted over /manual/agents, and the page on drawing and the sdctl params it writes from the avatar over
# /manual/avatar (ADR 0057).
COPY manual/ /manual/
RUN mkdir -p /manual/agents /manual/avatar
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/libexec/natsumi-workspace-runner"]
CMD ["serve"]

FROM node:24.12.0-bookworm-slim
ENV NODE_ENV=production
# git commits the memory repository (ADR 0018). Committing is the server's alone: natsumi has git in the workspace
# container above, but there /memory/.git is mounted read-only, so she can read the history and not write it.
# ripgrep and fd-find are for Pi's CLI, run here to log in: it looks for rg and fd (fdfind is one of fd's names to it)
# as it starts, and warns when it cannot fetch them offline. The thinking loop keeps Pi's own grep and find off.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep fd-find \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Only what the server runs. src/probe is a development tool against a live model; it belongs in the
# checkout, not here, and nothing under src/server or src/pi imports it. src/shared is the protocol the server shares
# with the browser's app (ADR 0058).
COPY --from=build /app/dist/src/server ./dist/src/server
COPY --from=build /app/dist/src/pi ./dist/src/pi
COPY --from=build /app/dist/src/shared ./dist/src/shared
# The browser's app, served at /app/ for the chat (/) and the settings (/settings) (ADR 0058).
COPY --from=build /app/dist/web ./dist/web
# natsumi, the avatar used when the config names none, and the faceless pictures and default params that fill in what
# an avatar lacks (ADR 0057). The apps fetch the avatar at /v1/avatar, and Slack its icons at /avatar/ (ADR 0040).
COPY assets/avatars/ ./assets/avatars/
# The page on drawing the server writes for the workspace from the avatar (ADR 0057).
COPY assets/manual/ ./assets/manual/
# The dashboard's style sheet and script, served at /dashboard/static/ (ADR 0049).
COPY assets/dashboard/ ./assets/dashboard/
# natsumi's manual (ADR 0036), the same as the workspace's /manual, read by the dashboard to show it (ADR 0054). The
# list of agents is read from the data directory's agents/, as the workspace mounts it over /manual/agents.
COPY manual/ ./manual/
# Mount points for the data directory and the dedicated Pi state area. A new named volume inherits
# this ownership and mode, so the unprivileged user can write without running as root.
RUN mkdir -p /data /var/lib/natsumi-pi \
  && chown node:node /data /var/lib/natsumi-pi \
  && chmod 700 /data /var/lib/natsumi-pi
USER node
# 8443: HTTPS with certificate files. 443 and 80: HTTPS and the ACME challenge listener (ADR 0007).
EXPOSE 8443 443 80
ENTRYPOINT ["node", "/app/dist/src/server/main.js"]
CMD ["serve", "--config", "/etc/natsumi/config.json", "--data-dir", "/data"]
