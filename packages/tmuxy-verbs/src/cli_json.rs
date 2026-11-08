//! A verb's answer, under the CLI's contract (`tmuxy_core::cli_contract`):
//! text, or under `--json` one object on stdout, and the exit code.

use tmuxy_core::cli_contract::{json_failure, json_ok};
pub use tmuxy_core::cli_contract::{
    json_string as string, EXIT_FAILED, EXIT_NO_SERVER, EXIT_TARGET, EXIT_USAGE,
};

pub struct Answer {
    json: bool,
}

impl Answer {
    pub fn new(json: bool) -> Self {
        Self { json }
    }

    /// Each value in `fields` is already a JSON literal (see [`string`]).
    pub fn done(&self, fields: &[(&str, String)], text: &str) {
        if self.json {
            println!("{}", json_ok(fields));
        } else if !text.is_empty() {
            println!("{text}");
        }
    }

    pub fn is_json(&self) -> bool {
        self.json
    }

    pub fn fail(&self, code: i32, message: &str) -> i32 {
        self.fail_with(code, message, &[])
    }

    /// [`Answer::fail`], with `fields` after the failure's own under `--json`.
    pub fn fail_with(&self, code: i32, message: &str, fields: &[(&str, String)]) -> i32 {
        if self.json {
            println!("{}", json_failure(code, message, fields));
        } else {
            eprintln!("Error: {message}");
        }
        code
    }

    /// [`Answer::fail`], then exit with its code.
    pub fn exit(&self, code: i32, message: &str) -> ! {
        std::process::exit(self.fail(code, message))
    }
}
