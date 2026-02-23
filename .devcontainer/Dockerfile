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
    nano vim neovim jq yq bc \
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
ENV EDITOR=nano
ENV VISUAL=nano

# zsh with productivity plugins
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
    -p git -p fzf \
    -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
    -a "source /usr/share/doc/fzf/examples/completion.zsh" \
    -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    -a "export PATH=/usr/local/cargo/bin:\$PATH" \
    -a "[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh" \
    -x

# Add local bin, cargo, and npm global bin to profile (login shells, including non-interactive)
RUN echo 'export PATH=$HOME/.local/bin:/usr/local/cargo/bin:/usr/local/share/npm-global/bin:$PATH' >> /home/node/.profile

# Claude Code (native installer)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Global npm packages: pm2, agent-browser
RUN npm install -g pm2 agent-browser \
    && agent-browser install
