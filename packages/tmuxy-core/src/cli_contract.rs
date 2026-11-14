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
/// Keys were sent, and what was waited for after them did not happen
/// (`tmuxy pane send --wait`: stalled, stopped at a prompt, an error, another
/// program in the pane, out of time). Never for a send that typed nothing,
/// so a script that retries on a failure never sends twice.
pub const EXIT_SENT: i32 = 5;

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
    with_fields(String::from(r#"{"ok":true}"#), fields)
}

fn with_fields(mut object: String, fields: &[(&str, String)]) -> String {
    object.pop();
    for (name, value) in fields {
        object.push_str(&format!(",{}:{value}", json_string(name)));
    }
    object + "}"
}

/// A failure, from [`JSON_FAILURE_FORMAT`], and `fields` after its own.
pub fn json_failure(code: i32, message: &str, fields: &[(&str, String)]) -> String {
    let mut parts = JSON_FAILURE_FORMAT.splitn(3, "%s");
    let (head, middle, tail) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    with_fields(
        format!("{head}{}{middle}{code}{tail}", json_string(message)),
        fields,
    )
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
            json_failure(EXIT_TARGET, "no pane %s here", &[]),
            r#"{"ok":false,"error":"no pane %s here","code":3}"#
        );
        assert_eq!(
            json_failure(1, "x", &[("status", "1".into())]),
            r#"{"ok":false,"error":"x","code":1,"status":1}"#
        );
        assert_eq!(json_string("a\"b\u{1b}"), r#""a\"b\u001b""#);
    }

    /// The shell half's encoder (`json_string` in `bin/tmuxy/_contract`)
    /// writes every string the way this one does: a window name answers the
    /// same through `tmuxy tab list --json` as through a verb.
    #[cfg(unix)]
    #[test]
    fn the_shell_encoder_writes_what_this_one_writes() {
        let contract = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tmuxy-cli/bin/tmuxy/_contract");
        let mut value: String = (1u8..0x20).map(char::from).collect();
        value.push_str("\\ \" ' é \u{7f} %s & end");
        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(r#"source "$1"; json_string "$2""#)
            .arg("bash")
            .arg(&contract)
            .arg(&value)
            .output();
        let output = match output {
            Ok(output) => output,
            Err(e) => panic!("bash: {e}"),
        };
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), json_string(&value));
    }
}
