//! The `tmuxy` CLI's contract with scripts and agents (`tmuxy --help`, "Exit
//! codes"; `packages/tmuxy-cli/README.md`): the exit codes, and under `--json`
//! one object on stdout — `{"ok":true,…}` for a success,
//! `{"ok":false,"error","code"}` for a failure. The verbs answer through it
//! (`tmuxy-verbs` `cli_json`), and the shell half reads the same values from
//! `bin/tmuxy/_options`, generated from here (`tests/generated_constants.rs`).

pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
/// A target not found, or a label naming more than one pane.
pub const EXIT_TARGET: i32 = 3;
pub const EXIT_NO_SERVER: i32 = 4;

/// A failure under `--json`, as a `printf` format: the error message (a JSON
/// string literal), then the exit code.
pub const JSON_FAILURE_FORMAT: &str = r#"{"ok":false,"error":%s,"code":%s}"#;

/// `value` as a JSON string literal, quotes included: every control
/// character escaped, the rest as it is.
pub fn json_string(value: &str) -> String {
    serde_json::Value::from(value).to_string()
}

/// A success: `{"ok":true}` and `fields`, each value already a JSON literal.
pub fn json_ok(fields: &[(&str, String)]) -> String {
    let mut out = String::from(r#"{"ok":true"#);
    for (name, value) in fields {
        out.push_str(&format!(",{}:{value}", json_string(name)));
    }
    out + "}"
}

/// A failure, from [`JSON_FAILURE_FORMAT`].
pub fn json_failure(code: i32, message: &str) -> String {
    let mut parts = JSON_FAILURE_FORMAT.splitn(3, "%s");
    let (head, middle, tail) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    format!("{head}{}{middle}{code}{tail}", json_string(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_success_is_ok_and_its_fields_and_a_failure_its_message_and_code() {
        assert_eq!(
            json_ok(&[("paneId", json_string("%1")), ("sent", "true".into())]),
            r#"{"ok":true,"paneId":"%1","sent":true}"#
        );
        assert_eq!(
            json_failure(EXIT_TARGET, "no pane %s here"),
            r#"{"ok":false,"error":"no pane %s here","code":3}"#
        );
        assert_eq!(json_string("a\"b\u{1b}"), r#""a\"b\u001b""#);
    }
}
