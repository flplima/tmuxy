# Rich rendering: testing

How to try each protocol of [RICH-RENDERING.md](RICH-RENDERING.md) by hand, and the tests that hold them.

## Manual

```bash
# OSC 8 hyperlink
printf '\e]8;;https://example.com\e\\Click me\e]8;;\e\\\n'
ls --hyperlink=auto

# iTerm2 inline image (requires `imgcat` from iTerm2 utilities, or any
# tool that emits OSC 1337 File=…)
imgcat path/to/image.png

# Kitty graphics protocol
kitten icat path/to/image.png   # the official client
# or any application using zellij / ranger's kitty image preview

# Sixel
img2sixel path/to/image.png
chafa --format sixel path/to/image.png
```

Inside a real tmuxy session, each of these renders the image inline in the pane.

## Automated

- **Program status**: `tmuxy-core/src/control_mode/program_status/tests.rs` holds the parser, the records and the write to tmux. `tests/21-agent-states.test.js` prints each state in a real pane and checks the mark.
- **Rust unit tests** (`tmuxy-core/src/control_mode/images.rs`) cover the parsers and placement geometry — including chunked Kitty transfers, RGBA-to-PNG conversion, and Sixel decode.
- **E2E** runs a real tmux session, emits each protocol with a shell command, and asserts the `<img>` shows up in the page (see `tests/`).
