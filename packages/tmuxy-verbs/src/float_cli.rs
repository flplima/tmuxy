//! Runs inside `run-shell`, behind `bin/tmuxy/float-create` (`tmuxy pane
//! float`, the `tmuxy-float` alias, the MCP endpoint's `pane_float`), which
//! keeps what a shell does: reusing a float it already runs in, and waiting on
//! a command.

use tmuxy_core::float::{free_index, Backdrop, Drawer, Float};

/// A float's size when the caller names none, in terminal cells (never a
/// percentage: tmux sizes panes in cells, and so does the UI that draws the
/// float over them).
const DEFAULT_WIDTH: u32 = 60;
const DEFAULT_HEIGHT: u32 = 15;

#[derive(clap::Args, Debug)]
pub struct FloatArgs {
    /// The caller's pane: the float is split from it, over its tab, in its
    /// session, and gives it back the focus. The session's current pane when
    /// absent.
    #[arg(long)]
    pane: Option<String>,
    /// Width in cells.
    #[arg(long)]
    width: Option<u32>,
    /// Height in cells.
    #[arg(long)]
    height: Option<u32>,
    /// A drawer sliding in from this edge.
    #[arg(long, value_parser = ["left", "right", "top", "bottom"])]
    drawer: Option<String>,
    /// The backdrop behind the float.
    #[arg(long, value_parser = ["dim", "blur", "none"])]
    bg: Option<String>,
    #[arg(long)]
    hide_header: bool,
    /// The new pane's command, as one shell line; a shell when absent.
    #[arg(long)]
    command: Option<String>,
}

pub fn run(args: FloatArgs) {
    match make(args) {
        Ok(ids) => println!("{ids}"),
        Err(message) => {
            eprintln!("Error: {message}");
            std::process::exit(1);
        }
    }
}

fn read(argv: &[&str]) -> String {
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    tmuxy_core::session::tmux_output(&argv)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Act on the CALLER's pane, window and session, never on tmux's notion of
/// the current ones: with several clients attached to different sessions,
/// "current" is whichever session was touched last, and the float would be
/// split from (and broken out into) the wrong one.
fn make(args: FloatArgs) -> Result<String, String> {
    let pane = args.pane.filter(|p| tmuxy_core::PaneId::parse(p).is_ok());
    let display = |format: &str| match &pane {
        Some(pane) => read(&["display-message", "-p", "-t", pane, format]),
        None => read(&["display-message", "-p", format]),
    };
    // No pane, no session: `:<index>` is the current session's.
    let session = match pane {
        Some(_) => display("#{session_name}"),
        None => String::new(),
    };
    let window = display("#{window_id}");
    let rows = display("#{window_height}").parse().unwrap_or(0);
    let mut list = vec!["list-windows", "-F", "#{window_index}"];
    if !session.is_empty() {
        list.extend(["-t", &session]);
    }
    let at = format!("{session}:{}", free_index(&read(&list)));

    let drawer = args.drawer.as_deref().map(|d| match d {
        "left" => Drawer::Left,
        "right" => Drawer::Right,
        "top" => Drawer::Top,
        _ => Drawer::Bottom,
    });
    let (width, height) = default_size(args.width, args.height, drawer, rows);
    let float = Float {
        from_pane: pane,
        cwd: None,
        command: args.command,
        at,
        parent_window: Some(window).filter(|w| !w.is_empty()),
        width,
        height,
        drawer,
        backdrop: args.bg.as_deref().map(|b| match b {
            "dim" => Backdrop::Dim,
            "blur" => Backdrop::Blur,
            _ => Backdrop::None,
        }),
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

/// The default height is never taller than the tab (`rows`, 0 when unknown):
/// a float with more rows than the window has nowhere to put them. An explicit
/// height is the caller's call.
fn default_size(
    width: Option<u32>,
    height: Option<u32>,
    drawer: Option<Drawer>,
    rows: u32,
) -> (Option<u32>, Option<u32>) {
    let default_height = if rows > 0 && rows < DEFAULT_HEIGHT {
        rows
    } else {
        DEFAULT_HEIGHT
    };
    match (width, height, drawer) {
        (None, None, None) => (Some(DEFAULT_WIDTH), Some(default_height)),
        (None, None, Some(d)) if d.docks_by_width() => (Some(DEFAULT_WIDTH), None),
        (None, None, Some(_)) => (None, Some(default_height)),
        (None, Some(h), Some(d)) if d.docks_by_width() => (Some(DEFAULT_WIDTH), Some(h)),
        (Some(w), None, Some(d)) if !d.docks_by_width() => (Some(w), Some(default_height)),
        (w, h, _) => (w, h),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sizes and the backdrop reach the float's command list from a
    /// client, so anything but a number, or a backdrop by name, is refused
    /// before a command is built.
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
        ] {
            assert!(
                Cli::try_parse_from(["float", bad[0], bad[1]]).is_err(),
                "{bad:?}"
            );
        }
        assert!(Cli::try_parse_from(["float", "--width", "50", "--bg", "blur"]).is_ok());
    }

    #[test]
    fn a_float_takes_the_default_size_its_shape_docks_by() {
        assert_eq!(default_size(None, None, None, 40), (Some(60), Some(15)));
        // Never taller than the tab.
        assert_eq!(default_size(None, None, None, 10), (Some(60), Some(10)));
        assert_eq!(
            default_size(None, None, Some(Drawer::Left), 40),
            (Some(60), None)
        );
        assert_eq!(
            default_size(None, None, Some(Drawer::Top), 40),
            (None, Some(15))
        );
        assert_eq!(
            default_size(None, Some(30), Some(Drawer::Right), 40),
            (Some(60), Some(30))
        );
        assert_eq!(
            default_size(Some(90), None, Some(Drawer::Bottom), 8),
            (Some(90), Some(8))
        );
        // A size named for a centred float is the caller's, even half of one.
        assert_eq!(default_size(Some(90), None, None, 40), (Some(90), None));
        assert_eq!(default_size(None, Some(99), None, 40), (None, Some(99)));
    }
}
