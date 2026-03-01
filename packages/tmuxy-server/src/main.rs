mod dev;
mod server;
pub mod sse;
pub mod state;
use clap::Parser;

#[derive(Parser)]
#[command(
    name = "tmuxy-server",
    about = "Tmuxy production server with embedded frontend"
)]
struct Cli {
    #[command(flatten)]
    server: server::ServerArgs,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    server::run(cli.server).await;
}
