# Tmuxy Dev Container
# Based on the official Claude Code devcontainer pattern with project-specific tools:
# tmux 3.5a, Rust, pm2, agent-browser

FROM node:22

ARG TZ
ENV TZ="$TZ"

# Rename the base image's built-in `node` user/group to `user`
# and move its home directory accordingly. Done before anything else
# so all subsequent steps can reference the renamed identity.
RUN usermod -l user -d /home/user -m node \
    && groupmod -n user node

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools
    less git procps sudo fzf zsh man-db unzip gnupg2 openssh-server \
    nano vim jq bc \
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
    && mkdir /run/sshd \
    && ssh-keygen -A \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && echo "user ALL=(root) NOPASSWD: /usr/sbin/sshd" > /etc/sudoers.d/sshd \
    && chmod 440 /etc/sudoers.d/sshd \
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

# Build tmux 3.5a from source
# Debian ships 3.3a which crashes when external commands run while control mode is attached
RUN curl -sL https://github.com/tmux/tmux/releases/download/3.5a/tmux-3.5a.tar.gz | tar xz \
    && cd tmux-3.5a && ./configure && make -j$(nproc) && make install \
    && cd .. && rm -rf tmux-3.5a

# Rust toolchain
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup component add rustfmt clippy \
    && cargo install cargo-watch tauri-driver \
    && mkdir -p /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R user:user /usr/local/cargo /usr/local/rustup

# Ensure `user` has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R user:user /usr/local/share

# Persist command history
RUN mkdir /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R user /commandhistory

ENV DEVCONTAINER=true

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

# Trust the workspace bind mount: host uid differs from container `user`,
# which otherwise trips git's "dubious ownership" check on /tmuxy.
RUN git config --system --add safe.directory /tmuxy

# Switch to non-root user
USER user

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=/home/user/.local/bin:$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/zsh
ENV EDITOR=nvim
ENV VISUAL=nvim

# zsh with Pure prompt
RUN git clone https://github.com/sindresorhus/pure.git /home/user/.zsh/pure
COPY --chown=user:user .devcontainer/.zshrc /home/user/.zshrc

# Add local bin, cargo, and npm global bin to profile (login shells, including non-interactive)
# `yolo` shortcut mirrors the zsh function in .zshrc — needed because bin/devcontainer drops into bash.
RUN echo 'export PATH=$HOME/.local/bin:/usr/local/cargo/bin:/usr/local/share/npm-global/bin:$PATH' >> /home/user/.profile \
    && echo 'yolo() { claude --dangerously-skip-permissions "$@"; }' >> /home/user/.profile

# Claude Code (native installer)
RUN curl -fsSL https://claude.ai/install.sh | bash

# LazyVim — bootstrap config then pre-install plugins headlessly
RUN git clone https://github.com/LazyVim/starter ~/.config/nvim \
    && rm -rf ~/.config/nvim/.git \
    && nvim --headless "+Lazy! sync" +qa 2>&1

# Pre-create credential dirs with user ownership so the named volume
# mounts (see bin/devcontainer, compose.yml, devcontainer.json) are
# writable. Credentials are never mounted from the host — users log in
# inside (gh auth login, claude login, ssh-keygen) and the volumes
# persist that state across restarts.
RUN mkdir -p /home/user/.config/gh /home/user/.config/git /home/user/.claude \
    && mkdir -p -m 700 /home/user/.ssh

# Global npm packages: pm2, agent-browser
# ARM64 Linux has no playwright-bundled Chromium — use system chromium instead
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN npm install -g pm2 agent-browser \
    && if [ "$(dpkg --print-architecture)" != "arm64" ]; then agent-browser install; fi
