#!/usr/bin/env bash
#
# Shared container setup, idempotent and replayed on every (re)start.
#
# Runs identically in all three environments that host this workspace:
#   - GitHub Codespaces        (devcontainer.json postCreateCommand/postStartCommand)
#   - VS Code Dev Containers   (same)
#   - bin/devcontainer         (plain `docker run`, invoked from INIT_SCRIPT)
#
# Nothing here may assume a fixed workspace path: the repo root is derived from
# this script's own location, so it works at /workspaces/tmuxy, /tmuxy, or a
# path Codespaces picks for a multi-repo setup.
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[setup] Workspace: $ROOT_DIR"

mkdir -p "$HOME/.config/tmuxy" "$HOME/.local/bin"

# Symlink both conf files into the XDG path so edits in the repo take effect
# immediately. The Rust ensure_config skips overwriting when the target is a
# symlink, so it leaves these alone.
ln -sf "$ROOT_DIR/.devcontainer/.tmuxy.conf" "$HOME/.tmuxy.conf"
ln -sf "$ROOT_DIR/.devcontainer/.tmuxy.conf" "$HOME/.config/tmuxy/tmuxy.conf"
ln -sf "$ROOT_DIR/.devcontainer/.tmuxy.defaults.conf" "$HOME/.config/tmuxy/tmuxy.defaults.conf"
ln -sf "$ROOT_DIR/bin/tmuxy-cli" "$HOME/.local/bin/tmuxy"

# Codespaces manages git credentials, identity and the remote itself; the local
# container logs in with `gh auth login` and needs the helper wired up, an HTTPS
# remote, and its git config pointed at the persisted named volume. Setting
# GIT_CONFIG_GLOBAL inside a Codespace would hide the identity it injects, so it
# is exported here rather than in devcontainer.json's containerEnv.
if [ -z "${CODESPACES:-}" ]; then
    mkdir -p "$HOME/.config/git"
    if ! grep -q GIT_CONFIG_GLOBAL "$HOME/.profile" 2>/dev/null; then
        echo 'export GIT_CONFIG_GLOBAL=$HOME/.config/git/config' >> "$HOME/.profile"
    fi
    gh auth setup-git 2>/dev/null || true
    git -C "$ROOT_DIR" remote set-url origin \
        "$(git -C "$ROOT_DIR" remote get-url origin | sed 's|git@github.com:|https://github.com/|')" 2>/dev/null || true
fi

echo "[setup] Done"
