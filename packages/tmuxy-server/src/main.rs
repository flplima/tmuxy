use clap::Parser;
use tmuxy_server::server;

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
    // A screen-owning subcommand gets the quiet filter: a dependency's `WARN`
    // on stderr lands in the middle of the picture `browser --repl` is drawing.
    // Read from argv rather than after parsing, because the subscriber has to
    // be installed before anything can log.
    let owns_the_screen = std::env::args().any(|arg| arg == "browser");
    tmuxy_server::init_logging_with(if owns_the_screen {
        tmuxy_server::QUIET_LOG_FILTER
    } else {
        tmuxy_server::DEFAULT_LOG_FILTER
    });

    let cli = Cli::parse();
    server::run(cli.server).await;
}
