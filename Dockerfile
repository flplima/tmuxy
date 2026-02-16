# Tmuxy Dev Container
# Sandboxed environment for Claude Code with Rust, Node.js, and tmux

FROM debian:bookworm-slim

# System dependencies (tmux built from source below)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    bc \
    procps \
    yq \
    neovim \
    jq \
    libevent-dev \
    libncurses-dev \
    bison \
    && rm -rf /var/lib/apt/lists/*

# Build tmux 3.5a from source (Debian bookworm ships 3.3a which crashes with
# external write commands while control mode is attached)
RUN curl -sL https://github.com/tmux/tmux/releases/download/3.5a/tmux-3.5a.tar.gz | tar xz \
    && cd tmux-3.5a && ./configure && make -j$(nproc) && make install && cd .. && rm -rf tmux-3.5a

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal

# pm2 process manager
RUN npm install -g pm2

# Agent Browser (browser automation for Claude)
# Install Chromium dependencies first (agent-browser's --with-deps uses sudo which isn't available)
RUN apt-get update && apt-get install -y \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
    libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 \
    libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 \
    libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 \
    libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 \
    libcups2 libxshmfence1 libgbm1 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g agent-browser \
    && agent-browser install

# Non-root user (matches typical host UID)
RUN useradd -m -s /bin/bash -u 1000 claude

# Add cargo, claude, and dotfiles scripts to PATH (in .bashrc for tmux shells)
ENV PATH=/usr/local/cargo/bin:/home/claude/.local/bin:/home/claude/dotfiles/scripts:$PATH
RUN echo 'export PATH=/usr/local/cargo/bin:/home/claude/.local/bin:/home/claude/dotfiles/scripts:$PATH' >> /home/claude/.bashrc

# Ensure cargo directories are writable by claude user
RUN mkdir -p /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R claude:claude /usr/local/cargo

# Create log file writable by claude user
RUN touch /var/log/shell.log && chown claude:claude /var/log/shell.log

USER claude
WORKDIR /workspace

# Claude Code CLI (native install - installs to ~/.local/bin)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Default command - interactive bash with logging for docker logs
CMD ["script", "-q", "-a", "/var/log/shell.log", "-c", "claude --dangerously-skip-permissions"]
