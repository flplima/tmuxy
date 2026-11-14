//! The `float` verb, behind `bin/tmuxy/float-create` (`tmuxy pane float`,
//! the `tmuxy-float` alias), which keeps what a shell does: reusing a float
//! it already runs in, and waiting on a command. Its tmux command list goes
//! through `run-shell`. It answers `<pane> <window>`, or under `--json`
//! `paneId` and `windowId`.

use tmuxy_core::float::{default_size, Backdrop, Drawer, Float, Spot};
use tmuxy_core::PaneId;

use crate::cli_json::{self, Answer, EXIT_FAILED};

#[derive(clap::Args, Debug)]
pub struct FloatArgs {
    /// The caller's pane: the float is split from it, over its tab, in its
    /// session, and gives it back the focus. The session's current pane when
    /// absent.
    #[arg(long, value_parser = |p: &str| PaneId::parse(p).map(|_| p.to_string()))]
    pane: Option<String>,
    /// Width in cells.
    #[arg(long)]
    width: Option<u32>,
    /// Height in cells.
    #[arg(long)]
    height: Option<u32>,
    /// A drawer sliding in from this edge.
    #[arg(long, value_parser = |d: &str| Drawer::parse(d).ok_or("left, right, top or bottom"))]
    drawer: Option<Drawer>,
    /// The backdrop behind the float.
    #[arg(long, value_parser = |b: &str| Backdrop::parse(b).ok_or("dim, blur or none"))]
    bg: Option<Backdrop>,
    #[arg(long)]
    hide_header: bool,
    /// The new pane's command, as one shell line; a shell when absent.
    #[arg(long)]
    command: Option<String>,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
}

pub fn run(args: FloatArgs) {
    let answer = Answer::new(args.json);
    match make(args) {
        Ok(ids) => {
            let mut id = ids.split_whitespace().map(cli_json::string);
            let (pane, window) = (id.next().unwrap_or_default(), id.next().unwrap_or_default());
            answer.done(&[("paneId", pane), ("windowId", window)], &ids)
        }
        Err(message) => answer.exit(EXIT_FAILED, &message),
    }
}

fn read(argv: &[String]) -> Result<String, String> {
    tmuxy_core::session::tmux_output(argv)
        .map(|out| out.trim().to_string())
        .map_err(|e| format!("failed to create float pane: {e}"))
}

/// Act on the CALLER's pane, window and session, never on tmux's notion of
/// the current ones: with several clients attached to different sessions,
/// "current" is whichever session was touched last, and the float would be
/// split from (and broken out into) the wrong one.
fn make(args: FloatArgs) -> Result<String, String> {
    let pane = args.pane;
    let pane_out = read(&Spot::pane_read(pane.as_deref()))?;
    if let Some(pane) = pane.as_deref().filter(|p| !Spot::answered_by(&pane_out, p)) {
        return Err(format!("no such pane: {pane}"));
    }
    let spot = Spot::new(&pane_out, &read(&Spot::windows_read(&pane_out))?);

    let drawer = args.drawer;
    let (width, height) = default_size(args.width, args.height, drawer, spot.rows);
    let float = Float {
        from_pane: pane,
        cwd: None,
        command: args.command,
        at: spot.at(),
        parent_window: Some(spot.window).filter(|w| !w.is_empty()),
        width,
        height,
        drawer,
        backdrop: args.bg,
        no_header: args.hide_header,
    };
    let out = tmuxy_core::run_shell::tmux(&tmuxy_core::paths::Layout::current(), &float.argv())
        .map_err(|e| format!("failed to create float pane: {e}"))?;
    out.lines()
        .last()
        .map(str::trim)
        .filter(|ids| ids.split_whitespace().count() == 2)
        .map(String::from)
        .ok_or_else(|| "failed to create float pane".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sizes, the backdrop and the pane reach the float's command list
    /// from a client, so anything but a number, a name or a pane id is
    /// refused before a command is built.
    #[test]
    fn a_size_or_backdrop_that_is_not_one_is_refused() {
        #[derive(clap::Parser)]
        struct Cli {
            #[command(flatten)]
            float: FloatArgs,
        }
        use clap::Parser as _;
        for bad in [
            ["--width", "50; touch /tmp/pwned"],
            ["--width", "#(touch /tmp/pwned)"],
            ["--height", "12' ; touch /tmp/pwned ; '"],
            ["--bg", "dim #(touch /tmp/pwned)"],
            ["--bg", "sideways"],
            ["--drawer", "sideways"],
            // A pane that is not one would split the float from tmux's
            // current pane, in whatever session it is in.
            ["--pane", "work:0"],
        ] {
            assert!(
                Cli::try_parse_from(["float", bad[0], bad[1]]).is_err(),
                "{bad:?}"
            );
        }
        assert!(Cli::try_parse_from(["float", "--width", "50", "--bg", "blur"]).is_ok());
    }
}
