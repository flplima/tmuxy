#!/usr/bin/env python3
"""
Turns on SGR mouse tracking (modes 1000, 1002 and 1006), reads raw terminal
input, and writes every SGR mouse report it gets to stdout and a log file, so
an E2E test can check what the UI sent to the pane.

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

            buf += data
            quit = False

            # Parse SGR mouse sequences: \x1b[<Pb;Px;Py{M|m}. A 'q' outside
            # one quits, whatever else came in the same read: the pty hands
            # over all that piled up, so a click's release and the 'q' typed
            # after it often arrive together on a busy machine.
            while buf:
                start = buf.find(b'\x1b')
                if b'q' in (buf if start == -1 else buf[:start]):
                    quit = True
                    break
                if start == -1:
                    buf = b''
                    break
                buf = buf[start:]
                if len(buf) < 3:
                    # Maybe the start of a report; the rest is in the next read.
                    break
                if not buf.startswith(b'\x1b[<'):
                    # Some other escape sequence: not a report, and not a 'q'.
                    buf = buf[1:]
                    continue

                # Terminated by 'M' (0x4d, press) or 'm' (0x6d, release).
                end = -1
                for j in range(3, len(buf)):
                    if buf[j] in (0x4d, 0x6d):
                        end = j
                        break
                    # Another ESC first: malformed.
                    if buf[j] == 0x1b:
                        break

                if end == -1:
                    # Incomplete, or malformed up to the next ESC.
                    if b'\x1b' in buf[1:]:
                        buf = buf[1:]
                        continue
                    break

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

                if term == 'm':
                    evt = 'release'
                elif btn >= 64:
                    evt = 'scroll_up' if btn == 64 else 'scroll_down'
                elif btn >= 32:
                    evt = 'drag'
                    btn -= 32  # +32 is the motion flag
                else:
                    evt = 'press'

                line = f'{evt}:btn={btn}:x={x}:y={y}'
                log.write(line + '\n')
                log.flush()
                os.write(1, (line + '\r\n').encode())

            if quit:
                break

finally:
    os.write(1, b'\033[?1000l\033[?1002l\033[?1006l')
    termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
