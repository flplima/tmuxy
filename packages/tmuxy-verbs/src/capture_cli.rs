//! The `capture-html` verb, behind `tmuxy pane capture --format html`: the
//! `capture-pane -e` text on stdin, as HTML on stdout
//! ([`tmuxy_core::capture_html`]).

use std::io::Read;

use crate::cli_json::{Answer, EXIT_FAILED};

pub fn html() {
    let mut capture = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut capture) {
        Answer::new(false).exit(EXIT_FAILED, &format!("failed to read the capture: {e}"));
    }
    print!(
        "{}",
        tmuxy_core::capture_html::capture_to_html(&String::from_utf8_lossy(&capture))
    );
}
