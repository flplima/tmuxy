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

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tmuxy"
mkdir -p "$DATA_DIR" "$HOME/.local/bin"

# Symlink the shipped confs into tmuxy's data dir, where the app mirrors them,
# so edits in the repo take effect immediately. The app never writes a
# generated file through a symlink, so it leaves these alone. The config dir
# (~/.config/tmuxy) is the user's: the app writes the starter tmuxy.conf there
# on its first run.
CONF_DIR="$ROOT_DIR/packages/tmuxy-core/assets"
ln -sf "$CONF_DIR/tmuxy.defaults.conf" "$DATA_DIR/tmuxy.defaults.conf"
ln -sf "$CONF_DIR/tmuxy.essentials.conf" "$DATA_DIR/tmuxy.essentials.conf"
ln -sf "$ROOT_DIR/packages/tmuxy-cli/bin/tmuxy-cli" "$HOME/.local/bin/tmuxy"

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
