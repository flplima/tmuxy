use tmuxy_server::server;

#[tokio::main]
async fn main() {
    if let Some(exe) = tmuxy_core::session::invoked_exe() {
        tmuxy_core::session::set_server_command(exe, None);
    }
    tmuxy_server::init_logging();

    server::run_argv(std::env::args_os()).await;
}
