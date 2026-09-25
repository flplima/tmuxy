# Tmuxy Dev Container
# Based on the official Claude Code devcontainer pattern with project-specific tools:
# tmux 3.7a, Rust, agent-browser

FROM node:22

ARG TZ
ENV TZ="$TZ"

# Rename the base image's built-in `node` user/group to `user` (uid/gid 1000)
# and move its home directory. Done before anything else so all subsequent
# steps can reference the renamed identity. The container is started with
# --user "$(id -u):$(id -g)" so the host uid matches automatically.
RUN usermod -l user -d /home/user -m node \
    && groupmod -n user node

# System dependencies
# What only an IMAGE needs: its base tools, its build deps, its browser. The
# agent tooling on top of this — fzf, neovim, jq, zstd, the CJK face, Xvfb and
# the WebKit driver — is `bin/install-dev-tools` below, shared with the cloud
# agent's runner so the two environments cannot drift apart again.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools (openssh-client for git-over-SSH and ssh-keygen credential setup;
    # openssh-server so `gh codespace ssh` can reach a Codespace — the Codespaces
    # agent starts sshd but does not install it)
    less git procps sudo unzip openssh-client openssh-server \
    # Build tools (tmux, native modules)
    build-essential pkg-config libssl-dev ca-certificates \
    libevent-dev libncurses-dev bison \
    # Chromium (agent-browser; ARM64 has no downloadable build so we use system)
    chromium \
    # Tauri build deps (WebKitGTK)
    libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev librsvg2-dev \
    # Scoped passwordless sudo for chown/chmod so the credential-volume ownership
    # fix (.devcontainer/fix-credential-ownership.sh) can repair root-owned/stale-UID
    # named volumes on container start.
    && echo "user ALL=(root) NOPASSWD: /usr/bin/chown, /usr/bin/chmod" > /etc/sudoers.d/user \
    && chmod 440 /etc/sudoers.d/user \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Neovim latest stable (used by tests/6-nvim-performance.test.js via `nvim --clean`)
RUN NVIM_ARCH=$(uname -m | sed 's/aarch64/arm64/') && \
    curl -sL "https://github.com/neovim/neovim/releases/download/stable/nvim-linux-${NVIM_ARCH}.tar.gz" \
    | tar xz -C /opt && \
    ln -sf /opt/nvim-linux-${NVIM_ARCH}/bin/nvim /usr/local/bin/nvim

# Build tmux 3.7a from source
# Debian ships an older tmux; build the version tmuxy targets everywhere.
RUN curl -sL https://github.com/tmux/tmux/releases/download/3.7a/tmux-3.7a.tar.gz | tar xz \
    && cd tmux-3.7a && ./configure && make -j$(nproc) && make install \
    && cd .. && rm -rf tmux-3.7a

# Rust toolchain
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup component add rustfmt clippy \
    # wasm32 target + pinned wasm-bindgen for tmuxy-wasm (npm run build:wasm);
    # the CLI version must match the wasm-bindgen crate in Cargo.lock
    && rustup target add wasm32-unknown-unknown \
    # i686-musl for the v86 guest's tmuxy-tree binary (scripts/build-v86-snapshot.mjs)
    && rustup target add i686-unknown-linux-musl \
    && mkdir -p /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R user:user /usr/local/cargo /usr/local/rustup

# The shared agent tooling (bin/install-dev-tools), run as root while apt still
# works: apt extras, cargo-watch, and — with --full — the Tauri E2E driver and
# the wasm-bindgen the v86 build needs. The env var above is what tells it a
# browser is already here, so it downloads none.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
COPY bin/install-dev-tools /tmp/install-dev-tools
RUN /tmp/install-dev-tools --full \
    && rm /tmp/install-dev-tools \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && chown -R user:user /usr/local/cargo /usr/local/rustup

# Ensure `user` has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R user:user /usr/local/share

# Persist command history
RUN mkdir /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R user /commandhistory

# The default workspace path for both Codespaces and VS Code Dev Containers.
# bin/devcontainer bind-mounts the worktree here too, so all hosts agree — and
# no script depends on it, each derives the repo root from its own location.
WORKDIR /workspaces/tmuxy

# Trust any workspace path so git doesn't complain about "dubious ownership"
# when the container user's uid differs from the mount owner. A wildcard is
# needed because the path differs per host (Codespaces can relocate it).
RUN git config --system --add safe.directory '*'

# Switch to non-root user
USER user

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=/home/user/.local/bin:$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/bash
ENV EDITOR=nvim
ENV VISUAL=nvim

# Bash login-shell setup: PATH, UTF-8 locale, and persistent history (backed by
# the /commandhistory volume created above). bin/devcontainer drops into `bash -l`.
RUN { \
      echo 'export PATH=$HOME/.local/bin:/usr/local/cargo/bin:/usr/local/share/npm-global/bin:$PATH'; \
      echo 'export LANG=C.UTF-8'; \
      echo 'export HISTFILE=/commandhistory/.bash_history'; \
      echo 'export HISTSIZE=10000'; \
      echo 'export HISTFILESIZE=10000'; \
      echo '[ -n "$BASH" ] && shopt -s histappend'; \
    } >> /home/user/.profile

# `yolo` — run Claude Code with all permission checks disabled. Installed as an
# executable on PATH (not a shell function) so it resolves in ANY shell: login or
# not, bash or sh — including `bin/devcontainer run sh`.
RUN mkdir -p /home/user/.local/bin \
    && printf '#!/usr/bin/env bash\nexec claude --dangerously-skip-permissions "$@"\n' > /home/user/.local/bin/yolo \
    && chmod +x /home/user/.local/bin/yolo

# Claude Code (native installer)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Pre-create credential dirs with user ownership so the named volume
# mounts (see bin/devcontainer and devcontainer.json) are
# writable. Credentials are never mounted from the host — users log in
# inside (gh auth login, claude login, ssh-keygen) and the volumes
# persist that state across restarts.
RUN mkdir -p /home/user/.config/gh /home/user/.config/git /home/user/.claude \
    && mkdir -p -m 700 /home/user/.ssh

# The single Chromium for everything Playwright-driven — the e2e suite
# (tests/helpers/browser.js launch fallback), the storybook probe
# (packages/tmuxy-ui/scripts/probe-stories.mjs) and agent-browser — is the
# system one, named by PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH above: arm64 has no
# downloadable build, so a system binary is required there and used on every
# arch for consistency. Hence no `playwright install` step.
