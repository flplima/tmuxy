# Tmuxy Dev Container
# Based on the official Claude Code devcontainer pattern with project-specific tools:
# tmux 3.7a, Rust, pm2, agent-browser

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools (openssh-client for git-over-SSH and ssh-keygen credential setup)
    less git procps sudo fzf unzip openssh-client jq zstd \
    # Build tools (tmux, native modules)
    build-essential pkg-config libssl-dev ca-certificates \
    libevent-dev libncurses-dev bison \
    # Chromium (agent-browser; ARM64 has no playwright-bundled build so we use system)
    chromium \
    # CJK + fullwidth glyphs, so headless Chromium renders them at their real
    # width. Without a CJK face the wide-glyph TerminalLine stories measure a
    # 1-cell fallback box and fail locally while passing on CI runners that
    # ship fonts. wqy-zenhei is ~16MB, against ~250MB for fonts-noto-cjk.
    fonts-wqy-zenhei \
    # Tauri build deps (WebKitGTK) and E2E test deps (Xvfb, WebKitWebDriver)
    libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev librsvg2-dev \
    webkit2gtk-driver xvfb x11-utils \
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
    && cargo install cargo-watch tauri-driver \
    && cargo install wasm-bindgen-cli --version 0.2.111 --locked \
    && mkdir -p /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R user:user /usr/local/cargo /usr/local/rustup

# Ensure `user` has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R user:user /usr/local/share

# Persist command history
RUN mkdir /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R user /commandhistory

WORKDIR /tmuxy

# Trust the workspace bind mount so git doesn't complain about "dubious ownership"
# when the container user's uid differs from the bind mount owner.
RUN git config --system --add safe.directory /tmuxy

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

# Global npm packages: pm2, agent-browser
# The system chromium (installed above) is the single Chromium for every
# Playwright-driven test: the e2e suite (tests/helpers/browser.js launch
# fallback) and the storybook probe (packages/tmuxy-ui/scripts/probe-stories.mjs)
# both read this env var and pass it as Playwright's `executablePath`. ARM64 has
# no Playwright-bundled build, so the system binary is required there; we use it
# on all arches for consistency, which is why no `playwright install` step is
# needed for the test browsers.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN npm install -g pm2 agent-browser \
    && if [ "$(dpkg --print-architecture)" != "arm64" ]; then agent-browser install; fi
