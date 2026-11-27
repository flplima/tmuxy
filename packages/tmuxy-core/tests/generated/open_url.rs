//! What the `browser` script needs to hand a URL to the client: the marker it
//! writes, the longest URL, and the rule a link is checked by.

use std::fmt::Write as _;

use tmuxy_core::constants as k;

use super::quoted;

pub fn shell(out: &mut String) {
    // ANSI-C quoting: the set holds both a quote and a backslash.
    let forbidden: String = k::URL_FORBIDDEN_CHARS
        .iter()
        .map(|c| match c {
            '\\' | '\'' => format!("\\{c}"),
            c => c.to_string(),
        })
        .collect();
    let _ = writeln!(
        out,
        "\n# How the browser script hands a URL to the client (`OPEN_URL_MARKER`), and\n\
         # which URLs it hands over (`host::command::is_openable_url`).\n\
         OPEN_URL_MARKER={}\nMAX_OPEN_URL_BYTES={}\nOPENABLE_URL_SCHEMES={}\nURL_FORBIDDEN_CHARS=$'{forbidden}'",
        quoted(k::OPEN_URL_MARKER),
        k::MAX_OPEN_URL_BYTES,
        quoted(&k::OPENABLE_URL_SCHEMES.join(" ")),
    );
}
