# Tmuxy Dev Container
# Sandboxed environment for Claude Code with Rust, Node.js, and tmux

FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    tmux \
    curl \
    git \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    bc \
    procps \
    yq \
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

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user (matches typical host UID)
RUN useradd -m -s /bin/bash -u 1000 claude

# Add cargo and dotfiles scripts to PATH (in .bashrc for tmux shells)
ENV PATH=/usr/local/cargo/bin:/home/claude/dotfiles/scripts:$PATH
RUN echo 'export PATH=/usr/local/cargo/bin:/home/claude/dotfiles/scripts:$PATH' >> /home/claude/.bashrc

# Ensure cargo directories are writable by claude user
RUN mkdir -p /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R claude:claude /usr/local/cargo

USER claude
WORKDIR /workspace

# Default command
CMD ["claude"]
