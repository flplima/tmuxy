#!/usr/bin/env bash
# Heavy TUI simulation: alternate-screen rendering with many cell updates.
#
# Used by e2e tests to verify tmuxy renders alt-screen content identically
# to what `tmux capture-pane` produces. The script:
#   1. Enters alternate screen and hides the cursor.
#   2. Draws a complex layout: header, ruler, 256-color grid, attribute
#      samplers, status panel.
#   3. Performs multiple update rounds that rewrite specific cells with
#      different colors / attributes — exercising vt100 cell mutation,
#      not just append-only output.
#   4. Prints a TUI_READY marker as the last thing rendered so tests can
#      synchronise.
#   5. Sleeps forever; caller terminates with SIGTERM / SIGINT.

set -u

# Use \033 (not \e) — POSIX-portable across bash builds.
ESC=$'\033'

csi()   { printf '%s[%s' "$ESC" "$1"; }
goto()  { csi "${1};${2}H"; }
fg()    { csi "38;5;${1}m"; }
bg()    { csi "48;5;${1}m"; }
sgr()   { csi "${1}m"; }
reset() { csi '0m'; }

# Alt-screen on + hide cursor
csi '?1049h'
csi '?25l'

# Restore on exit
trap 'csi "?25h"; csi "?1049l"; exit 0' INT TERM EXIT

# Clear and home
csi '2J'
goto 1 1

# --- Header ---
sgr 1; fg 33
printf 'TUI BENCH - Heavy Alternate Screen Rendering'
reset

goto 2 1
fg 240
i=0
while [ $i -lt 60 ]; do printf '%s' '-'; i=$((i+1)); done
reset

# --- 256-color grid (rows 4..7, 6 cells per row) ---
row=4
while [ $row -le 7 ]; do
  col=1
  cell=0
  while [ $cell -lt 6 ]; do
    x=$((1 + cell * 10))
    goto "$row" "$x"
    c=$(( (row * 6 + cell) * 7 % 256 ))
    fg "$c"
    printf 'c%03d' "$c"
    reset
    cell=$((cell + 1))
  done
  row=$((row + 1))
done

# --- Attribute sampler (row 9) ---
goto 9 1
sgr 1; printf 'BOLD'; reset; printf ' '
sgr 3; printf 'ITALIC'; reset; printf ' '
sgr 4; printf 'UNDER'; reset; printf ' '
sgr 7; printf ' INV '; reset; printf ' '
fg 196; bg 17; printf ' RED-ON-BLUE '; reset

# --- Status panel (rows 11..15) ---
goto 11 1
fg 226; sgr 1; printf 'STATUS:'; reset; printf ' '; fg 46; printf 'READY'; reset

goto 12 1
fg 117; printf 'host:'; reset; printf ' '; fg 213; printf 'tmuxy-test'; reset

goto 13 1
fg 117; printf 'mode:'; reset; printf ' '; fg 213; printf 'alt-screen'; reset

goto 14 1
fg 117; printf 'rounds:'; reset; printf ' '; fg 213; printf '5'; reset

goto 15 1
fg 240; printf 'press Ctrl+C to exit'; reset

# --- Update phase: rewrite cells in already-drawn regions ---
# This exercises vt100 cell mutation, not just append-only output.
r=1
while [ $r -le 5 ]; do
  # Update progress bar at row 17
  goto 17 1
  fg 240; printf '[ '; reset
  filled=$((r * 6))
  total=30
  k=0
  while [ $k -lt $filled ]; do
    sgr 7; fg 46; printf '#'; reset
    k=$((k + 1))
  done
  while [ $k -lt $total ]; do
    fg 240; printf '.'; reset
    k=$((k + 1))
  done
  fg 240; printf ' ] '; reset
  fg 226; printf '%d%%' "$((r * 20))"; reset

  # Rewrite a status field at column 30 each round with a different value.
  goto 11 30
  fg 240; printf 'tick='; reset
  fg 208; sgr 1; printf '%02d' "$r"; reset

  r=$((r + 1))
done

# --- Final ready marker (last rendered cell) ---
goto 22 1
sgr 1; bg 22; fg 231; printf ' TUI_READY '; reset

# Park forever — terminate via signal.
while :; do
  sleep 1
done
