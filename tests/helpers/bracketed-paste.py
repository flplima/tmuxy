#!/usr/bin/env python3
"""
A program that asks for bracketed paste, the way a shell, an editor or an
agent's TUI does, and reports how the first input it is given arrived.

Turns on `?2004h`, prints READY, then reads until one of:

    PASTED:<text>     a bracketed paste (ESC[200~ ... end marker); the text's
                      line breaks are shown as `|`, an ESC as `^[`
    SUBMITTED:<text>  a Return outside any paste — what a multi-line paste
                      typed a key at a time looks like to such a program

and exits, restoring the terminal.

The end marker is found the way an ECMA-48 parser finds it (libvterm,
crossterm and the like): a CSI, as `ESC [` or the 8-bit C1 `U+009B`, whose
parameter reads as the NUMBER 201 — so `ESC [ 0201 ~` ends the paste too.
Whatever follows the end within the same read is taken as typed input.
"""

import os
import re
import sys
import termios
import tty

START = '\x1b[200~'
CSI_TILDE = re.compile('(?:\x1b\\[|\x9b)([0-9]+)~')

fd = sys.stdin.fileno()
old_attrs = termios.tcgetattr(fd)


def paste_end(text):
    """The span of the first CSI 201 ~ in `text`, or None."""
    for match in CSI_TILDE.finditer(text):
        if int(match.group(1)) == 201:
            return match.span()
    return None


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
        text = buf.decode('utf-8', errors='replace')
        if text.startswith(START):
            end = paste_end(text[len(START):])
            if end is not None:
                pasted = text[len(START):len(START) + end[0]]
                shown = pasted.replace('\r', '|').replace('\n', '|').replace('\x1b', '^[')
                result = ('PASTED:' + shown).encode()
        elif '\r' in text:
            result = ('SUBMITTED:' + text[:text.index('\r')]).encode()
    os.write(1, b'\x1b[?2004l')
    os.write(1, (result or b'EOF') + b'\r\n')
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
