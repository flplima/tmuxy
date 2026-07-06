#!/usr/bin/env bash
#
# bin/devcontainer entrypoint. The container is started as root (--user 0:0)
# so this script can align the `user` account with the HOST uid/gid before
# dropping privileges and exec'ing the real command as `user`.
#
# Why: the workspace is bind-mounted from the host and the credential named
# volumes are pre-created owned by uid 1000. If the host account isn't uid 1000
# (common on Linux), running directly as that uid leaves /tmuxy and the volumes
# unwritable and yields an "I have no name!" shell. Remapping `user` to the host
# uid/gid makes a single chown fix all of /home/user, the workspace, and the
# volumes — for ANY host uid.
#
# macOS: HOST_UID/HOST_GID are left unset (Docker Desktop maps bind-mount
# ownership automatically), so no remap happens and we just drop to user 1000.
#
# Idempotent: on restart the target uid already matches and the remap is skipped.
set -e

TARGET_UID="${HOST_UID:-$(id -u user)}"
TARGET_GID="${HOST_GID:-$(id -g user)}"

if [ "$TARGET_GID" != "$(id -g user)" ]; then
    groupmod -o -g "$TARGET_GID" user
fi
if [ "$TARGET_UID" != "$(id -u user)" ]; then
    usermod -o -u "$TARGET_UID" user
    # Fix the image-layer parts of $HOME (.profile, .config/nvim, .local, etc.).
    # The credential volumes are handled by fix-credential-ownership.sh below.
    chown -R "$TARGET_UID:$TARGET_GID" /home/user
fi

# Repair credential named-volume ownership (older volumes, stale uids). Runs as
# root here, so it chowns directly with no sudo dependency.
/tmuxy/.devcontainer/fix-credential-ownership.sh || true

# Drop privileges to `user` (now the host uid/gid) and run the command. HOME is
# forced because setpriv preserves root's environment otherwise.
exec setpriv --reuid user --regid user --init-groups env HOME=/home/user "$@"
