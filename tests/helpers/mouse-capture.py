#!/usr/bin/env python3
"""
Mouse event capture script for E2E testing.

Enables SGR mouse tracking (modes 1000 + 1006), reads raw terminal input,
parses SGR mouse escape sequences, and writes events to both stdout and a
log file. This lets E2E tests verify the correct escape sequences are sent
from the tmuxy UI to the tmux pane.

Usage:
    python3 mouse-capture.py [logfile]

The logfile defaults to /tmp/mouse-events.log.

Output format (one event per line):
    press:btn=0:x=10:y=5
    release:btn=0:x=10:y=5
    drag:btn=0:x=12:y=5
    scroll_up:btn=64:x=10:y=5
    scroll_down:btn=65:x=10:y=5

Prints READY to stdout when mouse tracking is enabled.
Send 'q' to quit gracefully.
"""

import os
import sys
import termios
import tty

LOGFILE = sys.argv[1] if len(sys.argv) > 1 else '/tmp/mouse-events.log'

fd = sys.stdin.fileno()
old_attrs = termios.tcgetattr(fd)

try:
    tty.setraw(fd)

    # Enable SGR mouse tracking:
    # 1000 = button event tracking (press/release)
    # 1002 = button motion tracking (drag while button held)
    # 1006 = SGR extended encoding (\033[<...M/m instead of legacy encoding)
    os.write(1, b'\033[?1000h\033[?1002h\033[?1006h')

    with open(LOGFILE, 'w') as log:
        log.write('READY\n')
        log.flush()
        os.write(1, b'READY\r\n')

        buf = b''
        while True:
            data = os.read(fd, 4096)
            if not data:
                break

            # Check for 'q' to quit (outside of escape sequences)
            if b'q' in data and b'\x1b' not in data:
                break

            buf += data

            # Parse SGR mouse sequences: \x1b[<Pb;Px;Py{M|m}
            while b'\x1b[<' in buf:
                start = buf.index(b'\x1b[<')

                # Discard any non-sequence bytes before the escape
                if start > 0:
                    buf = buf[start:]
                    start = 0

                # Find the terminator: 'M' (0x4d) or 'm' (0x6d)
                end = -1
                for j in range(3, len(buf)):
                    if buf[j] in (0x4d, 0x6d):
                        end = j
                        break
                    # If we hit another ESC, this sequence is malformed
                    if buf[j] == 0x1b:
                        break

                if end == -1:
                    # Incomplete sequence, wait for more data
                    break

                # Extract and parse: \x1b[<btn;x;y{M|m}
                inner = buf[3:end].decode('ascii', errors='replace')
                term = chr(buf[end])
                buf = buf[end + 1:]

                parts = inner.split(';')
                if len(parts) != 3:
                    continue

                try:
                    btn = int(parts[0])
                    x = int(parts[1])
                    y = int(parts[2])
                except ValueError:
                    continue

                # Classify event type
                if term == 'm':
                    evt = 'release'
                elif btn >= 64:
                    evt = 'scroll_up' if btn == 64 else 'scroll_down'
                elif btn >= 32:
                    evt = 'drag'
                    btn -= 32  # Report the original button number
                else:
                    evt = 'press'

                line = f'{evt}:btn={btn}:x={x}:y={y}'
                log.write(line + '\n')
                log.flush()
                os.write(1, (line + '\r\n').encode())

finally:
    # Disable mouse tracking
    os.write(1, b'\033[?1000l\033[?1002l\033[?1006l')
    termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
