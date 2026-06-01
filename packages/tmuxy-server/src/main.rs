use clap::Parser;
use tmuxy_server::server;
use tracing_subscriber::{fmt, EnvFilter};

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
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("tmuxy_core=info,tmuxy_server=info,warn"));
    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(std::io::stderr)
        .try_init()
        .ok();

    let cli = Cli::parse();
    server::run(cli.server).await;
}
