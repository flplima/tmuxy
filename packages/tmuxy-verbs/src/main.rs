//! `tmuxy-verbs <verb>`: the verbs on a machine with no `tmuxy-server` to run
//! them, which is the in-browser guests (the v86 snapshot, the CheerpX image).
//! The CLI finds it where it finds no server (`find_server_cmd`).

use clap::Parser;

#[derive(Parser)]
#[command(
    name = "tmuxy-verbs",
    about = "Run a tmuxy CLI verb without the server"
)]
struct Cli {
    #[command(subcommand)]
    verb: tmuxy_verbs::Verb,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tmuxy_verbs::run(Cli::parse().verb).await;
}
