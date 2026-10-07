//! `tmuxy-group <verb>`: the pane-group operations as a binary of their own,
//! for the v86 guest, which has no `tmuxy-server` to run them.

use clap::Parser;

#[derive(Parser)]
#[command(name = "tmuxy-group", about = "Run a tmuxy pane-group operation")]
struct Cli {
    #[command(flatten)]
    args: tmuxy_group::GroupArgs,
}

fn main() {
    tmuxy_group::run(Cli::parse().args);
}
