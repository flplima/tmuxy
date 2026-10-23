#!/bin/sh
# Pack a root filesystem tar (stdin, as `docker export` writes it) as an ext2
# image on stdout, the way CheerpX wants it: 4 KiB blocks, sized to the
# contents plus headroom. Runs inside a throwaway native Alpine container, so
# no loop mount, no privileges and no bind mount are needed; only the image
# bytes may reach stdout.
set -e
apk add --no-cache -q e2fsprogs >&2
mkdir /rootfs
tar -xf - -C /rootfs
kb=$(du -sk /rootfs | cut -f1)
size=$(( kb * 13 / 10 + 8192 ))
mkfs.ext2 -q -b 4096 -L tmuxy -d /rootfs /tmuxy.ext2 "${size}K" >&2
cat /tmuxy.ext2
