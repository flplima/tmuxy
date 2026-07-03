//! Standalone `tmuxy-tree` binary — the same TUI `tmuxy-server tree` runs,
//! packaged separately so the v86 guest (which has no server binary) can run
//! the real sidebar tree. `bin/tmuxy-cli` prefers this binary when present.
fn main() {
    if let Err(e) = tmuxy_tree::run_tree_tui() {
        eprintln!("tmuxy tree: {e}");
        std::process::exit(1);
    }
}
