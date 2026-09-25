# A public, read-only tmuxy viewer, in a container that holds nothing worth taking.
#
# The threat model this image answers: the viewer is exposed to the internet, so
# assume someone finds a way to run a command through it despite `--read-only`.
# The isolation, not the flag, is what keeps that from mattering — the container
# has no source tree, no credentials, no host mounts and no network reach worth
# having, so a shell inside it is a shell in an empty room.
#
# Build from the repository root:
#   docker build -f deploy/public-demo/Dockerfile -t tmuxy-public-demo .
#
# Run it through deploy/public-demo/compose.yml, which adds the sandbox flags
# (dropped capabilities, read-only rootfs, no new privileges, resource caps).
# See deploy/public-demo/README.md.

# --- Stage 1: build the frontend ----------------------------------------------
# Its own stage on the official node image, not apt's node: Debian ships npm 9,
# which rejects this lock file outright.
FROM node:22-bookworm AS frontend

WORKDIR /src

# The lock file is written by npm 11, and npm 10 (what node:22 ships) resolves
# the optional proxy-agent tree differently and rejects it as out of sync. Pin
# the major rather than chase the error.
RUN npm install -g npm@11

# Every workspace manifest, so `npm ci` can resolve the lock file before the
# source arrives and a source-only change does not re-install.
COPY package.json package-lock.json ./
COPY packages/tmuxy-ui/package.json packages/tmuxy-ui/
COPY packages/tmuxy-demo/package.json packages/tmuxy-demo/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build -w tmuxy-ui

# --- Stage 2: build the server ------------------------------------------------
# A full Rust toolchain, thrown away. Only the binary crosses into the runtime.
# The server embeds packages/tmuxy-ui/dist at compile time (rust-embed), so the
# frontend stage has to land before cargo runs.
FROM rust:1-bookworm AS builder

WORKDIR /src
COPY . .
COPY --from=frontend /src/packages/tmuxy-ui/dist packages/tmuxy-ui/dist

RUN cargo build --release -p tmuxy-server \
    && strip target/release/tmuxy-server

# --- Stage 3: build tmux ------------------------------------------------------
# tmuxy requires tmux 3.4+ and bookworm ships 3.3a, so it is built from source.
# In its own stage: purging the build deps out of the runtime image took
# libevent's RUNTIME library with them, and tmux then would not start at all.
FROM debian:bookworm-slim AS tmux

ARG TMUX_VERSION=3.5a
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl build-essential libevent-dev libncurses-dev bison pkg-config \
    && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
        | tar -xz -C /tmp \
    && cd "/tmp/tmux-${TMUX_VERSION}" \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && make install \
    && strip /usr/local/bin/tmux

# --- Stage 4: the runtime -----------------------------------------------------
# tmux, one server binary, and the two shared libraries tmux links. No compiler,
# no npm, no git, no curl, no ssh client: nothing here can build, fetch or sign
# anything.
FROM debian:bookworm-slim

# Runtime libraries only — the `-dev` packages stay in the tmux stage. `procps`
# is for tmux; `ca-certificates` so an outbound TLS call fails with a
# certificate error rather than hanging.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates procps libevent-core-2.1-7 libncursesw6 libtinfo6 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tmux /usr/local/bin/tmux /usr/local/bin/tmux

# An unprivileged user with a home the container can throw away. uid 10001 is
# outside the range any host user is likely to hold, so a stray bind mount
# cannot land as a writable file owned by a real account.
RUN useradd --uid 10001 --create-home --shell /bin/bash demo

COPY --from=builder /src/target/release/tmuxy-server /usr/local/bin/tmuxy-server
COPY deploy/public-demo/showcase.sh /usr/local/bin/showcase
COPY deploy/public-demo/welcome.txt /usr/local/share/tmuxy-demo/welcome.txt
RUN chmod 0755 /usr/local/bin/tmuxy-server /usr/local/bin/showcase \
    && chmod 0644 /usr/local/share/tmuxy-demo/welcome.txt

USER demo
WORKDIR /home/demo

# The session the viewer shows must be the one a client asks for by default,
# which is the `tmuxy` in tmuxy_core::DEFAULT_SESSION_NAME. See showcase.sh.
ENV TMUX_SOCKET=tmuxy-public \
    TMUXY_SESSION=tmuxy \
    TMUXY_READ_ONLY=1 \
    TMUXY_PORT=9000

EXPOSE 9000

# `--host 0.0.0.0` with `--no-auth` is deliberate and only safe BECAUSE of the
# container: the port is published to loopback on the host and fronted by a
# tunnel, and there is nothing in here to protect. Never copy this pair onto a
# server that has your files on it.
ENTRYPOINT ["/usr/local/bin/showcase"]
