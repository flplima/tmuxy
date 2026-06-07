#!/usr/bin/env bash
#
# Container entrypoint (runs as root) that makes the image uid-agnostic.
#
# The workspace is a bind mount of the host repo, owned by the host's uid/gid.
# To keep /tmuxy writable for any developer regardless of their host account,
# remap the container `user` to match the workspace owner, re-own the dirs
# `user` must write to, then drop privileges and exec the real command as
# `user`. The image is built once (with `user` at the base 1000) and adapts at
# every start — no per-developer rebuild, and one image serves any uid.
#
# Counterpart for the VS Code Dev Containers path is `updateRemoteUserUID` in
# devcontainer.json; that toolchain performs the same remap on container create.
#
# Idempotent and cheap on the common path: deep chowns are skipped when a dir
# already matches, so persistent cache/credential volumes are only walked the
# first time a given uid is seen.
set -euo pipefail

WORKSPACE="${WORKSPACE_DIR:-/tmuxy}"

# Not root → nothing to remap (e.g. the image's default USER). Run as-is.
if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

if [ -d "$WORKSPACE" ]; then
  uid="$(stat -c '%u' "$WORKSPACE")"
  gid="$(stat -c '%g' "$WORKSPACE")"

  # A root-owned workspace carries no uid to match (e.g. an empty/odd mount);
  # leave `user` as built.
  if [ "$uid" -ne 0 ] && { [ "$uid" -ne "$(id -u user)" ] || [ "$gid" -ne "$(id -g user)" ]; }; then
    # -o/--non-unique tolerates a host uid/gid that already exists in the image
    # (e.g. host uid 1000 == the base image's node→user).
    groupmod -o -g "$gid" user
    usermod -o -u "$uid" -g "$gid" user

    # Image-layer dirs `user` owns. -xdev stays on each layer's filesystem so
    # the walk skips mounted volumes (handled with a conditional skip below);
    # -not -user avoids rewriting files already at the target uid.
    find /home/user /usr/local/cargo /usr/local/rustup /usr/local/share -xdev \
      -not -user "$uid" -exec chown -h "$uid:$gid" {} + 2>/dev/null || true

    # Persistent volumes: chown only when the top dir doesn't already match, so
    # the (potentially large) cache/credential trees aren't re-walked each start.
    for vol in \
      /usr/local/cargo/registry /usr/local/cargo/git /commandhistory \
      /home/user/.claude /home/user/.config/gh /home/user/.config/git /home/user/.ssh; do
      [ -d "$vol" ] || continue
      [ "$(stat -c '%u' "$vol")" = "$uid" ] && continue
      chown -R "$uid:$gid" "$vol" 2>/dev/null || true
    done

    # ssh refuses a group/world-accessible key dir.
    [ -d /home/user/.ssh ] && chmod 700 /home/user/.ssh
  fi
fi

# Drop privileges and hand off. runuser sets HOME/USER for `user` and preserves
# the passed-through environment (PORT, CLAUDE_CONFIG_DIR, …).
exec runuser -u user -- "$@"
