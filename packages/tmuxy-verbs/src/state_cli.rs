//! `tmuxy pane state explain`: where a pane's state came from, and what
//! reads its screen (docs/SCREEN-RULES.md).

use clap::Args;
use tmuxy_core::host::socket_watch::agent_rules::{
    explain::{explain, Facts},
    program,
    user::UserRules,
};

use crate::cli_json::{string, Answer, EXIT_TARGET};

#[derive(Args)]
pub struct StateExplainArgs {
    /// The pane, by id: the shell resolves a label first.
    pane: String,
    #[arg(long)]
    json: bool,
}

pub fn run(args: StateExplainArgs) {
    let answer = Answer::new(args.json);
    let Some(facts) = Facts::read(&args.pane) else {
        std::process::exit(answer.fail(EXIT_TARGET, &format!("no pane {}", args.pane)));
    };
    let program = program::program(facts.pid, &facts.command);
    let user = UserRules::read(&tmuxy_core::paths::config_dir().join("agents"));
    let found = explain(&facts, &program, &user);
    let json = serde_json::to_string(&found).unwrap_or_else(|_| "null".into());
    answer.done(
        &[("paneId", string(&args.pane)), ("explanation", json)],
        &found.render(&args.pane),
    );
}
