#!/usr/bin/env python3
"""
A program that reads keys the way a TUI does, and prints the bytes of each.

    key-bytes.py        asks the terminal for nothing, as a shell does
    key-bytes.py ask    asks for extended keys (CSI > 4 ; 2 m), as an editor
                        or a coding agent does

Puts the terminal in raw mode, prints READY, then one line for each key read:

    key1 [ESC[13;2u]
    key2 [CR]

ESC, CR, TAB and LF are spelled out, any other control byte is `^X`. A `q`
ends it, taking back the request and restoring the terminal.
"""

import os
import select
import sys
import termios
import tty

NAMES = {0x1B: 'ESC', 0x0D: 'CR', 0x09: 'TAB', 0x0A: 'LF', 0x7F: 'DEL'}


def readable(data):
    return ''.join(
        NAMES.get(byte) or ('^' + chr(byte + 64) if byte < 32 else chr(byte)) for byte in data
    )


fd = sys.stdin.fileno()
old_attrs = termios.tcgetattr(fd)
asks = sys.argv[1:] == ['ask']

try:
    tty.setraw(fd)
    if asks:
        os.write(1, b'\x1b[>4;2m')
    os.write(1, b'READY\r\n')
    count = 0
    while True:
        data = os.read(fd, 64)
        # One key's sequence can arrive in pieces: take what follows at once.
        while data and select.select([fd], [], [], 0.05)[0]:
            data += os.read(fd, 64)
        if not data or data == b'q':
            break
        count += 1
        os.write(1, f'key{count} [{readable(data)}]\r\n'.encode())
finally:
    if asks:
        os.write(1, b'\x1b[>4;0m')
    os.write(1, b'DONE\r\n')
    termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
