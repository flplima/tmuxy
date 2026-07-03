#!/usr/bin/env bash
# Ensure the credential named-volume mount points are owned by `user`.
#
# When a named volume is created on a mount path the image already defined with
# `user` ownership, Docker copies that ownership into the fresh volume — so new
# volumes are fine. But a volume created by an OLDER image (before these dirs
# existed in the Dockerfile) is stuck root-owned, and `updateRemoteUserUID` can
# also leave files owned by a stale UID. Either case breaks `gh auth login`,
# `claude login`, `ssh-keygen`, and the ~/.claude.json persistence daemon (which
# can't write into a root-owned ~/.claude volume).
#
# Invoked in two contexts, hence the dual privilege handling:
#   - bin/devcontainer's entrypoint.sh, as root: runs chown/chmod directly,
#     with no sudo dependency.
#   - devcontainer.json's postStartCommand, as `user`: elevates ONLY chown/chmod
#     via the scoped NOPASSWD sudoers rule the Dockerfile installs.
# Idempotent and safe to re-run on every container start.
set -euo pipefail

# No sudo needed when already root.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO=sudo; fi

DIRS=(
  /home/user/.claude
  /home/user/.config/gh
  /home/user/.config/git
  /home/user/.ssh
)

for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  # Skip the recursive chown unless the top dir is owned by someone other than
  # `user` — avoids walking the (large) ~/.claude tree on every start.
  if [ "$(stat -c %U "$d")" != user ]; then
    $SUDO chown -R user:user "$d"
  fi
done

# .ssh must be 0700 or ssh/sshd refuse to use it.
[ -d /home/user/.ssh ] && $SUDO chmod 700 /home/user/.ssh
