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
# Works in two privilege contexts:
#   - As `user` (devcontainer.json/compose.yml lifecycle): elevates ONLY
#     chown/chmod via the scoped NOPASSWD sudoers rule the Dockerfile installs.
#   - As root (bin/devcontainer's throwaway pre-start container): runs the same
#     chown/chmod directly, with no sudo dependency.
# Idempotent and safe to re-run on every container start.
set -euo pipefail

# No sudo when already root — the throwaway container has none configured.
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
