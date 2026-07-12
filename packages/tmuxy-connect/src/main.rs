//! Standalone `tmuxy-connect` binary — the "add a server" form the desktop
//! app opens in a float. `bin/tmuxy-cli` prefers this binary when present.
fn main() {
    match tmuxy_connect::run_connect_tui() {
        Ok(Some(id)) => println!("{id}"),
        Ok(None) => {} // cancelled — nothing added
        Err(e) => {
            eprintln!("tmuxy connect: {e}");
            std::process::exit(1);
        }
    }
}
