#!/usr/bin/env python3
"""
Asks the terminal for its cell size (CSI 16 t) and its text area in pixels
(CSI 14 t), the way a program that maps mouse pixels to cells would, and
prints every reply it reads, so an E2E test can read them off the pane.

Usage:
    python3 cell-size-query.py [--quiet SECONDS]

Each reply is printed on its own line, in the order it came, without its
ESC and CSI: a reply `ESC [ 6 ; 24 ; 9 t` prints as `reply=6;24;9`. The
program keeps reading until no byte has come for `--quiet` seconds (1 by
default), so a second answer to one query is seen too. It ends with a line
`replies=<n>`.
"""

import os
import re
import select
import sys
import termios
import tty

args = sys.argv[1:]
QUIET = 1.0
if '--quiet' in args:
    at = args.index('--quiet')
    QUIET = float(args[at + 1])

REPLY = re.compile(rb'\x1b\[([0-9;]*)t')

fd = sys.stdin.fileno()
old_attrs = termios.tcgetattr(fd)
replies = []
try:
    tty.setraw(fd)
    os.write(1, b'\x1b[16t\x1b[14t')
    buf = b''
    while True:
        ready, _, _ = select.select([fd], [], [], QUIET)
        if not ready:
            break
        data = os.read(fd, 4096)
        if not data:
            break
        buf += data
        for match in REPLY.finditer(buf):
            replies.append(match.group(1).decode('ascii'))
        buf = REPLY.sub(b'', buf)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)

for reply in replies:
    print(f'reply={reply}')
print(f'replies={len(replies)}')
