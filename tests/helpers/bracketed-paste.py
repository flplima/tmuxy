#!/usr/bin/env python3
"""
A program that asks for bracketed paste, the way a shell, an editor or an
agent's TUI does, and reports how the first input it is given arrived.

Turns on `?2004h`, prints READY, then reads until one of:

    PASTED:<text>     a bracketed paste (ESC[200~ ... ESC[201~); the text's
                      line breaks are shown as `|`
    SUBMITTED:<text>  a Return outside any paste — what a multi-line paste
                      typed a key at a time looks like to such a program

and exits, restoring the terminal.
"""

import os
import sys
import termios
import tty

START, END = b'\x1b[200~', b'\x1b[201~'

fd = sys.stdin.fileno()
old_attrs = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    os.write(1, b'\x1b[?2004h')
    os.write(1, b'READY\r\n')
    buf = b''
    result = None
    while result is None:
        data = os.read(fd, 4096)
        if not data:
            break
        buf += data
        if buf.startswith(START):
            if END in buf:
                text = buf[len(START):buf.index(END)]
                result = b'PASTED:' + text.replace(b'\r', b'|').replace(b'\n', b'|')
        elif b'\r' in buf:
            result = b'SUBMITTED:' + buf[:buf.index(b'\r')]
    os.write(1, b'\x1b[?2004l')
    os.write(1, (result or b'EOF') + b'\r\n')
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
