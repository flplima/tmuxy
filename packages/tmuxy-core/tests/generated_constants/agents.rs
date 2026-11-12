//! The agents the UI may type a diff review to, and the tmux format that
//! checks one is ready, as `tmuxyConstants.gen.ts` holds them.

use std::fmt::Write as _;

use tmuxy_core::host::socket_watch::agent_screen::{agent_takes_input_format, AGENT_COMMANDS};

use super::quoted;

pub(super) fn write(out: &mut String) {
    let _ = writeln!(
        out,
        "\n/** Agent process names (`AGENT_COMMANDS`). */\nexport const AGENT_COMMANDS = [{}] as const;\n\
         \n/** `agent_takes_input_format`. */\nexport const AGENT_TAKES_INPUT =\n  {};",
        AGENT_COMMANDS.map(quoted).join(", "),
        quoted(&agent_takes_input_format())
    );
}
