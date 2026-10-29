# A live browser in a pane

Companion to [RICH-RENDERING.md](RICH-RENDERING.md): `tmuxy widget browser`, the moving-picture
case of the image pipeline, built in.

`tmuxy widget browser <url>` (also `tmuxy browser`) is the moving-picture case
above, built in: a headless Chrome drawn into a pane and driven from it. The
shell entry is `packages/tmuxy-cli/bin/tmuxy/tmuxy-widget-browser`, which only
finds a node 22 or newer (the script opens its own WebSocket, so it needs no
package) and runs `browser.js` beside it; the pure mappings live in
`browser-lib.js` and are what `tests/cli/cli-browser.test.js` reads.

The script starts a Chrome of its own (`--chrome`, `TMUXY_CHROME`, or the
first of google-chrome, chromium and Playwright's chromium it finds) or
attaches to one by its DevTools endpoint (`--cdp`: a `ws://` URL, an
`http://host:port`, or a port — what `agent-browser get cdp-url` prints
works). It opens the page in a tab whose viewport is the pane's cells, every
row but the last, at a fixed 8 × 16 pixels a cell (`--cell`), and takes a
DevTools screenshot of it `--fps` times a second (the DevTools screencast was
tried first and stalls in a headless window after its first frames; a
screenshot never does). A frame that differs from the last is one Kitty
transfer in `f=100` form — the JPEG (or `--png`) bytes as Chrome encoded them,
in 4096-byte chunks, wrapped in tmux's passthrough — sized to the cells with
`c=` and `r=` and anchored at the home cell, so it replaces the previous frame
in place through the same-anchor rule above, one write at a time. A frame
asked for while a navigation swaps the page's renderer fails and the next
tick asks again. The last row is a status line in plain text: the
page's title and address, so `tmuxy pane capture` still says what the pane
shows. On a resize the tab follows the pane and the next frame is the new
size.

The pane's input is the page's: the script puts the terminal on the alternate
screen with the cursor hidden and the mouse tracked (`?1003h`, `?1006h`), and
reads its stdin raw. Printable text is inserted, named keys and Ctrl chords
are key presses, and the SGR mouse reports the UI forwards while the program
tracks the mouse become clicks, drags and wheels on the pixel at the middle
of their cell — which is why the viewport is cells times a known cell size: a
cell is a block of pixels the page can be addressed by. A script drives it
the same way a person does: `tmuxy pane send -t <pane>` types into the page,
and an SGR report sent as literal keys is a click on that cell. Ctrl+Q ends
the session and leaves the alternate screen, which takes the pictures with
it; Ctrl+C reaches the page.

Limits worth knowing: a frame is a screenshot, so a page that changes between
two ticks shows only what the second one caught, and `--fps` is a ceiling the
pane's output path may not reach; the picture is a cell grid's
worth of pixels (640 × 368 for an 80 × 24 pane), so small text is small;
audio, file dialogs, popups and new windows stay in the headless browser; and
the keyboard layer forwards what the pane delivers, so a key the UI or tmux
keeps for itself (a prefix chord) never reaches the page. The E2E
`tests/17-widget-browser.test.js` drives the whole path on CI's runner, whose
image ships a Chrome.
