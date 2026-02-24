mod embedded;
mod float;
mod group;
mod image;
mod markdown;
mod server;
pub mod sse;
pub mod web;
mod widget;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "tmuxy",
    about = "Tmuxy CLI: production server, pane groups, floats, and widgets"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start, stop, or check the production web server
    Server(server::ServerArgs),

    /// Float pane operations
    Float(float::FloatArgs),

    /// Pane group operations
    Group(group::GroupArgs),

    /// Display an image in a widget pane
    Image(image::ImageArgs),

    /// Display markdown in a widget pane
    #[command(alias = "markdown")]
    Md(markdown::MdArgs),
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Server(args) => {
            server::run(args).await;
        }
        Commands::Float(args) => {
            float::run(args);
        }
        Commands::Group(args) => {
            group::run(args);
        }
        Commands::Image(args) => {
            image::run(args);
        }
        Commands::Md(args) => {
            markdown::run(args);
        }
    }
}
