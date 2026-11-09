# A host for the desktop suite's ssh windows (tests/tauri/tauri-app-ssh.test.js):
# sshd taking a password and certificates from a CA the suite makes, and the
# tmux a window attaches to. The suite starts it on a free loopback port and
# removes it after; the password and the CA are the run's own.
ARG ALPINE=3.24
FROM alpine:${ALPINE}
RUN apk add --no-cache openssh tmux bash \
 && ssh-keygen -A \
 && adduser -D -s /bin/bash tester \
 && printf '%s\n' \
      'PasswordAuthentication yes' \
      'KbdInteractiveAuthentication no' \
      'PermitRootLogin no' \
      'TrustedUserCAKeys /etc/ssh/tmuxy_ca.pub' \
      > /etc/ssh/sshd_config.d/tmuxy.conf \
 && grep -q 'Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config \
 || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
