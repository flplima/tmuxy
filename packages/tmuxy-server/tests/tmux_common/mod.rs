//! A tmux server of the test's own, on a socket named for the test and this
//! process, with no control-mode client attached: the verbs' tmux calls are as
//! safe here as inside `run-shell`. Killed on drop, a failed assert included.

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Command;

pub struct ScratchTmux {
    pub socket: String,
    /// A home of the test's own, for a verb that reads or writes tmuxy's dirs.
    pub home: PathBuf,
}

impl ScratchTmux {
    /// Session `work`, `cols` by `rows`, with no config read.
    pub fn start(name: &str, cols: u16, rows: u16) -> Self {
        let socket = format!("tmuxy-{name}-{}", std::process::id());
        let home = std::env::temp_dir().join(&socket);
        std::fs::create_dir_all(&home).unwrap();
        let server = Self { socket, home };
        let (cols, rows) = (cols.to_string(), rows.to_string());
        server.tmux(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "work",
            "-x",
            &cols,
            "-y",
            &rows,
        ]);
        server
    }

    pub fn tmux(&self, args: &[&str]) -> String {
        let out = Command::new("tmux")
            .args(["-L", &self.socket])
            .args(args)
            .output()
            .expect("tmux runs");
        assert!(
            out.status.success(),
            "tmux {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

impl Drop for ScratchTmux {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .args(["-L", &self.socket, "kill-server"])
            .output();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}
