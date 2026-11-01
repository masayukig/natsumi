# syntax=docker/dockerfile:1
FROM node:24.22.2-trixie-slim AS build
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
FROM node:24.22.2-trixie-slim AS ipv6-netns
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
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags='-s -w' github.com/yuanying/sdctl@v0.4.0

# kubectl for the workspace (ADR 0085), a fixed release of the clusters' minor, checked against the checksum published
# beside it. Renovate reads the version from the ARG line as a Kubernetes release.
FROM debian:trixie-slim AS kubectl
ARG KUBECTL_VERSION=v1.37.2
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir /out && cd /out \
  && curl -fsSLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
  && curl -fsSLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" \
  && echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check \
  && chmod 755 kubectl && rm kubectl.sha256

# sops for the workspace (ADR 0088), a fixed release, checked against the checksums published with it. Debian trixie
# has none. Renovate reads the version from the ARG line as a release of getsops/sops.
FROM debian:trixie-slim AS sops
ARG SOPS_VERSION=v3.13.3
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir /out && cd /out \
  && curl -fsSLO "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.linux.${TARGETARCH}" \
  && curl -fsSLO "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.checksums.txt" \
  && grep " sops-${SOPS_VERSION}.linux.${TARGETARCH}\$" "sops-${SOPS_VERSION}.checksums.txt" | sha256sum --check \
  && mv "sops-${SOPS_VERSION}.linux.${TARGETARCH}" sops && chmod 755 sops && rm "sops-${SOPS_VERSION}.checksums.txt"

# Go's toolchain for the workspace (ADR 0088): the one the runner and sdctl are built with. GOTOOLCHAIN is local in
# $GOROOT/go.env, the lowest of Go's defaults, so a go.mod asking for another Go fetches nothing; the environment and
# `go env -w` still come first. GOPROXY is left as Go ships it, as the relay's port is the deployment's.
FROM golang:1.27 AS go
RUN sed -i 's/^GOTOOLCHAIN=.*/GOTOOLCHAIN=local/' /usr/local/go/go.env \
  && grep -qx 'GOTOOLCHAIN=local' /usr/local/go/go.env

# Ruby for the workspace (ADR 0088): the official build of a fixed 4.0 release, on the same Debian as the workspace. Its
# interpreter, libraries, headers and default gems are gathered into /out/local to be laid over /usr/local, and the
# bundle and bundler it ships into /out/bundler, out of PATH, behind the wrapper in the workspace. Its ENV (GEM_HOME and
# BUNDLE_*) is not taken: the runner passes none of it (ADR 0019). Renovate moves the tag and the digest together.
FROM ruby:4.0.9-slim-trixie@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df AS ruby
RUN mkdir -p /out/local/lib /out/local/include /out/bundler \
  && cp -a /usr/local/bin /usr/local/etc /out/local/ \
  && cp -a /usr/local/lib/ruby /usr/local/lib/libruby.so* /usr/local/lib/pkgconfig /out/local/lib/ \
  && cp -a /usr/local/include/ruby-* /out/local/include/ \
  && mv /out/local/bin/bundle /out/local/bin/bundler /out/bundler/

# natsumi's workspace (ADR 0019): an ordinary Debian environment with Python, and no network reaching it.
# There is no list of allowed commands any more; the confinement is the container's shape alone (compose.yaml).
# poppler-utils (pdftotext, pdftoppm) is for reading PDFs: those taken in from Slack (ADR 0072) and those attached to a
# chat message (ADR 0071). poppler-data holds the CJK character maps, without which a Japanese PDF gives no text and its
# pages render blank.
# kubectl, ssh's client and curl are for the relays of ADR 0085, which an instance chooses in its deployment; in one that
# does not, they reach nothing. libnss-wrapper is for the ssh wrapper below.
# Ruby, from the stage above, is for the Ruby CLIs an instance runs from a clone, installing their gems with bundle (ADR
# 0088). libyaml-0-2, libffi8, libgmp10, libssl3t64 and zlib1g are what the official image installs for it to run. gcc,
# make and libc6-dev build a gem's C extension; build-essential would add g++ and dpkg-dev, which no C extension needs.
# age makes the keys sops encrypts with; Debian's is enough for that, and apt checks it, where age's releases publish no
# checksum.
FROM debian:trixie-slim AS workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash coreutils findutils diffutils grep sed gawk tar gzip ripgrep jq python3 git procps tzdata poppler-utils poppler-data \
       openssh-client libnss-wrapper curl ca-certificates \
       libyaml-0-2 libffi8 libgmp10 libssl3t64 zlib1g gcc make libc6-dev age \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ruby /out/local/ /usr/local/
COPY --from=ruby /out/bundler/ /usr/libexec/bundler/
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
# The CLIs that use the relays (ADR 0085). Their settings are files named on the command line (kubectl --kubeconfig,
# ssh -F), as the runner passes no KUBECONFIG. The ssh in PATH is a wrapper that lends ssh a line of /etc/passwd when
# the UID it runs as has none; see the file.
COPY --from=kubectl /out/kubectl /usr/local/bin/kubectl
COPY --chmod=755 docker/ssh/ssh /usr/local/bin/ssh
# The bundle in PATH (ADR 0088) installs gems under HOME, as Gem's own directory is on the read-only root and the
# runner passes no GEM_HOME or bundler setting; see the file.
COPY --chmod=755 docker/bundler/bundle /usr/local/bin/bundle
COPY --chmod=755 docker/bundler/bundle /usr/local/bin/bundler
# sops reads its age key from ~/.config/sops/age/keys.txt, under HOME, as the runner passes no SOPS_AGE_KEY_FILE.
COPY --from=sops /out/sops /usr/local/bin/sops
# Go in /usr/local/go, as it ships, with go and gofmt linked onto the runner's PATH. GOPATH and GOCACHE are Go's
# defaults under HOME.
COPY --from=go /usr/local/go /usr/local/go
RUN ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/
# git reads the memory's history in /memory, which the server owns (ADR 0018, 0033); see the file for why it is trusted.
COPY docker/workspace/gitconfig /etc/gitconfig
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

FROM node:24.22.2-trixie-slim
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
