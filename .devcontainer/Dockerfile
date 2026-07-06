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
    less git procps sudo fzf man-db unzip gnupg2 openssh-client \
    nano vim jq bc zstd \
    # LazyVim runtime deps (telescope file/text search)
    ripgrep fd-find \
    # Build tools (tmux, native modules)
    build-essential pkg-config libssl-dev ca-certificates \
    libevent-dev libncurses-dev bison \
    # Chromium (agent-browser; ARM64 has no playwright-bundled build so we use system)
    chromium \
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

# Neovim latest stable (Bookworm ships 0.7 which is too old for LazyVim — requires 0.9+)
ARG LAZYGIT_VERSION=0.44.1
RUN NVIM_ARCH=$(uname -m | sed 's/aarch64/arm64/') && \
    curl -sL "https://github.com/neovim/neovim/releases/download/stable/nvim-linux-${NVIM_ARCH}.tar.gz" \
    | tar xz -C /opt && \
    ln -sf /opt/nvim-linux-${NVIM_ARCH}/bin/nvim /usr/local/bin/nvim && \
    # lazygit (optional LazyVim integration)
    curl -sL "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_$(uname -m | sed 's/aarch64/arm64/').tar.gz" \
    | tar xz -C /usr/local/bin lazygit

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

# git-delta for better diffs
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
    wget -q "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# yq (mikefarah) for YAML processing — apt's yq is a jq wrapper, not the real thing
ARG YQ_VERSION=v4.44.6
RUN ARCH=$(dpkg --print-architecture) && \
    wget -q "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}" -O /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

# Pre-create /home/linuxbrew owned by user so the Homebrew installer (run as
# non-root below) doesn't need sudo to create it.
RUN mkdir -p /home/linuxbrew && chown user:user /home/linuxbrew

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
      echo 'export PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$HOME/.local/bin:/usr/local/cargo/bin:/usr/local/share/npm-global/bin:$PATH'; \
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

# LazyVim — bootstrap config then pre-install plugins headlessly
RUN git clone https://github.com/LazyVim/starter ~/.config/nvim \
    && rm -rf ~/.config/nvim/.git \
    && nvim --headless "+Lazy! sync" +qa 2>&1

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

# Homebrew (Linuxbrew) — used to install the released tmuxy binary alongside
# the dev build so we can run a second instance on port 9090 for comparison/testing.
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH
# AppImages need FUSE, which isn't available in Docker — extract-and-run instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1
RUN brew install flplima/tap/tmuxy
