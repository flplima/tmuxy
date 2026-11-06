//! A verb's answer, as the CLI's contract has it (`packages/tmuxy-cli/README.md`,
//! the shell side is `bin/tmuxy/_contract`): text, or under `--json` one object
//! on stdout — `{"ok":true,…}` for a success, `{"ok":false,"error","code"}`
//! for a failure — and the exit code.

pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_TARGET: i32 = 3;

/// One string as a JSON string literal, quotes included.
pub fn string(value: &str) -> String {
    serde_json::Value::from(value).to_string()
}

/// `{"ok":true}` plus `fields`, each value a JSON literal.
fn ok_object(fields: &[(&str, String)]) -> String {
    let mut out = String::from(r#"{"ok":true"#);
    for (name, value) in fields {
        out.push_str(&format!(",{}:{value}", string(name)));
    }
    out + "}"
}

pub struct Answer {
    json: bool,
}

impl Answer {
    pub fn new(json: bool) -> Self {
        Self { json }
    }

    /// A success: `{"ok":true}` plus `fields` (each value a JSON literal)
    /// under `--json`, else `text` on stdout.
    pub fn done(&self, fields: &[(&str, String)], text: &str) {
        if self.json {
            println!("{}", ok_object(fields));
        } else if !text.is_empty() {
            println!("{text}");
        }
    }

    /// A failure, said as the mode wants it; returns the exit code.
    pub fn fail(&self, code: i32, message: &str) -> i32 {
        if self.json {
            println!(
                r#"{{"ok":false,"error":{},"code":{code}}}"#,
                string(message)
            );
        } else {
            eprintln!("Error: {message}");
        }
        code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_success_is_ok_and_its_fields_and_a_string_is_escaped() {
        assert_eq!(
            ok_object(&[("paneId", string("%1")), ("sent", "true".into())]),
            r#"{"ok":true,"paneId":"%1","sent":true}"#
        );
        assert_eq!(string("a\"b\u{1b}"), r#""a\"b\u001b""#);
    }
}
