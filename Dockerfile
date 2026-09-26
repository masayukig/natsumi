# syntax=docker/dockerfile:1
FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
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
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags='-s -w' github.com/yuanying/sdctl@v0.3.1

# natsumi's workspace (ADR 0019): an ordinary Debian environment with Python, and no network reaching it.
# There is no list of allowed commands any more; the confinement is the container's shape alone (compose.yaml).
FROM debian:bookworm-slim AS workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash coreutils findutils diffutils grep sed gawk tar gzip ripgrep python3 git procps tzdata \
  && rm -rf /var/lib/apt/lists/*
# A name for the default UID, and the mount points of the four writable places.
RUN groupadd --gid 1000 natsumi \
  && useradd --uid 1000 --gid 1000 --home-dir /home/natsumi --shell /bin/bash natsumi \
  && mkdir -p /memory /work /home/natsumi /run/natsumi-workspace \
  && chown natsumi:natsumi /work /home/natsumi
# Outside PATH, so running it by its path gives nothing bash does not already have.
COPY --from=workspace-runner /out/natsumi-workspace-runner /usr/libexec/natsumi-workspace-runner
# sdctl and its defaults (ADR 0044): the relay, the params and /work/images, baked in, so changing them is a new image.
# They are in a config file and not in ENV, because the runner gives natsumi's commands none of the image's environment
# (ADR 0019); the sdctl in PATH is a wrapper that always points the real one at that file. With these, `sdctl txt2img
# --prompt <file>` needs nothing else, and prints only the path it saved to.
COPY --from=sdctl /out/sdctl /usr/libexec/sdctl
COPY --chmod=755 docker/sdctl/sdctl /usr/local/bin/sdctl
COPY docker/sdctl/config.yaml /etc/sdctl/config.yaml
COPY docker/sdctl/anima.yaml /etc/sdctl/anima.yaml
# natsumi's manual (ADR 0036), read-only like the rest of the root. The list of agents the server writes on every
# start is mounted over /manual/agents.
COPY manual/ /manual/
RUN mkdir -p /manual/agents
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
# checkout, not here, and nothing under src/server or src/pi imports it.
COPY --from=build /app/dist/src/server ./dist/src/server
COPY --from=build /app/dist/src/pi ./dist/src/pi
# The faces Slack shows beside what the dove posts, served at /avatar/ (ADR 0040).
COPY assets/avatar/*.png ./assets/avatar/
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
