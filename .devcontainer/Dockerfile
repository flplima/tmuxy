# Tmuxy Dev Container
# Based on the official Claude Code devcontainer pattern with project-specific tools:
# tmux 3.5a, Rust, pm2, agent-browser

FROM node:22

ARG TZ
ENV TZ="$TZ"

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools
    less git procps sudo fzf zsh man-db unzip gnupg2 openssh-server \
    nano vim jq yq bc \
    # LazyVim runtime deps (telescope file/text search)
    ripgrep fd-find \
    # Build tools (tmux, native modules)
    build-essential pkg-config libssl-dev ca-certificates \
    libevent-dev libncurses-dev bison \
    # Chromium dependencies (agent-browser)
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
    libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 \
    libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 \
    libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 \
    libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 \
    libcups2 libxshmfence1 libgbm1 \
    && mkdir /run/sshd \
    && ssh-keygen -A \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && echo "node ALL=(root) NOPASSWD: /usr/sbin/sshd" > /etc/sudoers.d/sshd \
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
    && cargo install cargo-watch \
    && mkdir -p /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R node:node /usr/local/cargo /usr/local/rustup

# Ensure node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global \
    && chown -R node:node /usr/local/share

# Persist command history
RUN mkdir /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R node /commandhistory

ENV DEVCONTAINER=true

# Create workspace and config directories
RUN mkdir -p /workspace /home/node/.claude \
    && chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

# git-delta for better diffs
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
    wget -q "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Switch to non-root user
USER node

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=/home/node/.local/bin:$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/zsh
ENV EDITOR=nvim
ENV VISUAL=nvim

# zsh with Pure prompt
RUN git clone https://github.com/sindresorhus/pure.git /home/node/.zsh/pure
COPY --chown=node:node docker/.zshrc /home/node/.zshrc

# Add local bin, cargo, and npm global bin to profile (login shells, including non-interactive)
RUN echo 'export PATH=$HOME/.local/bin:/usr/local/cargo/bin:/usr/local/share/npm-global/bin:$PATH' >> /home/node/.profile

# Claude Code (native installer)
RUN curl -fsSL https://claude.ai/install.sh | bash

# LazyVim — bootstrap config then pre-install plugins headlessly
RUN git clone https://github.com/LazyVim/starter ~/.config/nvim \
    && rm -rf ~/.config/nvim/.git \
    && nvim --headless "+Lazy! sync" +qa 2>&1

# Global npm packages: pm2, agent-browser
RUN npm install -g pm2 agent-browser \
    && agent-browser install
