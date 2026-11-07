//! The preview widget's lines for the UI and the CLI, and the dev loop's
//! ports and the session size a fresh connection starts at for the CLI.

use std::fmt::Write as _;

use tmuxy_core::constants::{preview_lines, DEFAULT_SERVER_PORT, DEV_VITE_PORT};
use tmuxy_core::control_mode::{INITIAL_PTY_COLS, INITIAL_PTY_ROWS};

use super::quoted;

pub fn typescript(out: &mut String) {
    let _ = writeln!(
        out,
        "\n/** The lines `tmuxy-widget-preview` prints (`constants::preview_lines`). */\n\
         export const PREVIEW_LINES = {{\n  noTheme: {},\n  file: {},\n  rev: {},\n}} as const;",
        quoted(preview_lines::NO_THEME),
        quoted(preview_lines::FILE),
        quoted(preview_lines::REV)
    );
}

pub fn shell(out: &mut String) {
    let _ = writeln!(
        out,
        "\n# `tmuxy server`'s default port, and Vite's behind it in the dev loop.\n\
         DEFAULT_PORT={DEFAULT_SERVER_PORT}\nVITE_PORT={DEV_VITE_PORT}"
    );
    let _ = writeln!(
        out,
        "\n# The size a fresh control-mode connection starts a session at.\n\
         INITIAL_PTY_COLS={INITIAL_PTY_COLS}\nINITIAL_PTY_ROWS={INITIAL_PTY_ROWS}"
    );
    let _ = writeln!(
        out,
        "\n# The lines tmuxy-widget-preview prints for the client's preview.\n\
         PREVIEW_NO_THEME={}\nPREVIEW_FILE={}\nPREVIEW_REV={}",
        quoted(preview_lines::NO_THEME),
        quoted(preview_lines::FILE),
        quoted(preview_lines::REV)
    );
}
