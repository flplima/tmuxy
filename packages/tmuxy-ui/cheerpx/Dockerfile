# The CheerpX guest: 32-bit Alpine with bash, tmux built from source (with
# every patches/*.patch applied), the tmuxy-pty preload compiled from the
# crate's preload.c, and the tmuxy scripts and config where the v86 guest has
# them. scripts/build-cheerpx-image.mjs stages the `guest/` and `patches/`
# context directories and preload.c, builds this, exports the container's
# root and packs it as the ext2 image CheerpX mounts (cheerpx/pack.sh).
#
# One stage on purpose: Docker's legacy builder loses a `COPY --from` of a
# stage built for another platform than the daemon's.
ARG ALPINE=3.22
FROM --platform=linux/386 alpine:${ALPINE}
ARG TMUX_VERSION=3.7c

COPY patches/ /patches/
COPY preload.c /preload.c
RUN set -e \
 && apk add --no-cache bash libevent ncurses-terminfo-base libncursesw \
 && apk add --no-cache --virtual .build-deps build-base libevent-dev ncurses-dev bison curl patch \
 && mkdir /src && cd /src \
 && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
    | tar -xz --strip-components=1 \
 && for p in /patches/*.patch; do [ -e "$p" ] || continue; echo "applying $p"; patch -p1 < "$p"; done \
 && ./configure --prefix=/usr --sysconfdir=/etc \
 && make -j"$(nproc)" \
 && make install \
 && strip /usr/bin/tmux \
 && gcc -O2 -shared -fPIC -o /usr/lib/tmuxy-pty.so /preload.c \
 && cd / && rm -rf /src /patches /preload.c \
 && apk del .build-deps

COPY guest/ /
# A pane is not a terminal: full-screen programs are tmuxy-no-tui instead.
RUN for app in vi less more top; do ln -sf /usr/local/bin/tmuxy-no-tui "$(command -v $app)"; done
# The essentials' command-aliases run scripts under $HOME/.config/tmuxy/bin.
RUN ln -sf /opt/tmuxy/bin/tmuxy-cli /usr/bin/tmuxy \
 && mkdir -p /root/.config/tmuxy/bin \
 && ln -sfn /opt/tmuxy/bin/tmuxy /root/.config/tmuxy/bin/tmuxy
