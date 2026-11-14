//! `ask::Tmux` on a scratch server, as plain tmux subprocesses: for tests
//! with no control-mode client attached (`scratch.rs`).

#![allow(dead_code)]

use tmuxy_core::ask::{self, Argv};
use tmuxy_core::CommandError;

pub struct RealTmux<'a>(pub &'a str);

impl ask::Tmux for RealTmux<'_> {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        let out = tmuxy_core::session::local_tmux_on(self.0)
            .args(&argv)
            .output()
            .map_err(|e| CommandError::tmux(e.to_string()))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            Err(CommandError::tmux(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ))
        }
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        let argv = commands.join(&";".to_string());
        let out = tmuxy_core::session::local_tmux_on(self.0)
            .args(&argv)
            .output()
            .map_err(|e| CommandError::tmux(e.to_string()))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(CommandError::tmux(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ))
        }
    }
}
