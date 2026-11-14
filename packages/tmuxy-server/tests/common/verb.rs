//! Running one of the server binary's verbs in a home and on a socket of the
//! test's own, with nothing of a live tmux session in its environment.

use std::path::Path;
use std::process::{Command, Output};

pub fn verb_in(home: &Path, socket: &str, pane: Option<&str>, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"));
    command
        .args(args)
        .env("TMUX_SOCKET", socket)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("TMUXY_STATE_DIR", home.join("state"))
        .env_remove("TMUX")
        .env_remove("TMUXY_DATA_DIR")
        .env_remove("TMUX_PANE");
    if let Some(pane) = pane {
        command.env("TMUX_PANE", pane);
    }
    command.output().expect("tmuxy-server runs")
}

pub fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}
