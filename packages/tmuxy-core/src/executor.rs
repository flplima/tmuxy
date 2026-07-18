use std::process::Command;
use tracing::{debug, trace};

use crate::constants::tmux_options;
use crate::error::TmuxError;
use crate::WindowType;

type Result<T> = std::result::Result<T, TmuxError>;

/// Information about a single pane
#[derive(Debug, Clone)]
pub struct PaneInfo {
    pub id: String, // e.g., "%0"
    pub index: u32, // pane index in window
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub active: bool,
    pub command: String,      // current running command (e.g., "bash", "vim")
    pub title: String,        // pane title (set by shell/application)
    pub border_title: String, // evaluated pane-border-format
    pub in_mode: bool,        // true if pane is in copy mode
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,
    pub window_id: String, // window this pane belongs to (e.g., "@0")
    /// Number of history (scrollback) lines for this pane. Sourced from
    /// `#{history_size}`. Must be populated in polling mode so the frontend
    /// can request the correct FETCH_SCROLLBACK_CELLS range on first connect
    /// — before control-mode list-panes deltas update the field — otherwise
    /// copy mode entered immediately after page load can't see scrollback.
    pub history_size: u64,
}

/// Information about a tmux window
#[derive(Debug, Clone)]
pub struct WindowInfo {
    /// Window ID (e.g., "@0")
    pub id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
}

pub fn execute_tmux_command(args: &[&str]) -> Result<String> {
    let output = crate::session::tmux_command().args(args).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        // Promote a couple of well-known tmux error patterns to typed
        // variants. Everything else falls back to ControlMode.
        let trimmed = stderr.trim();
        if let Some(rest) = trimmed.strip_prefix("can't find session: ") {
            return Err(TmuxError::SessionNotFound {
                name: rest.to_string(),
            });
        }
        if let Some(rest) = trimmed.strip_prefix("can't find pane: ") {
            return Err(TmuxError::PaneNotFound {
                id: rest.to_string(),
            });
        }
        return Err(TmuxError::other(stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

/// Read a specific paste buffer by name (read-only; safe to run externally while
/// control mode is attached). Used to mirror a copy-mode yank to the web clipboard.
pub fn show_buffer_named(buffer_name: &str) -> Result<String> {
    execute_tmux_command(&["show-buffer", "-b", buffer_name])
}

/// Capture a range of scrollback lines from a pane.
/// start/end are line offsets using tmux capture-pane -S/-E convention:
/// negative = from history, 0 = first visible line, -S - means start of history.
pub fn capture_pane_range(pane_id: &str, start: i64, end: i64) -> Result<String> {
    execute_tmux_command(&[
        "capture-pane",
        "-t",
        pane_id,
        "-p",
        "-e",
        "-S",
        &start.to_string(),
        "-E",
        &end.to_string(),
    ])
}

// Tmux operations
pub fn split_pane_horizontal(session_name: &str) -> Result<()> {
    execute_tmux_command(&["split-window", "-t", session_name, "-h"])?;
    Ok(())
}

pub fn new_window(session_name: &str) -> Result<()> {
    // `new-window` (neww) crashes tmux 3.5a when control mode is attached.
    // Use `split-window` + `break-pane -d -P` instead, which achieves the
    // same result without crashing. `-P -F '#{window_id}'` prints the new
    // window's id so we can tag it with @tmuxy-window-type=tab without
    // racing the control-mode auto-adopt.
    //
    // The new window inherits the size of the broken-out pane (half the
    // source window after splitw), so we explicitly resize it to match the
    // source window's full dimensions before the user sees it.
    let size_output = execute_tmux_command(&[
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{window_width}x#{window_height}",
    ])
    .unwrap_or_default();
    let (cols, rows) = size_output
        .trim()
        .split_once('x')
        .and_then(|(c, r)| Some((c.parse::<u32>().ok()?, r.parse::<u32>().ok()?)))
        .unwrap_or((0, 0));

    execute_tmux_command(&["split-window", "-t", session_name])?;
    let new_window_id = execute_tmux_command(&["break-pane", "-d", "-P", "-F", "#{window_id}"])?;
    let new_window_id = new_window_id.trim();
    if !new_window_id.is_empty() {
        if cols > 0 && rows > 0 {
            let cols_s = cols.to_string();
            let rows_s = rows.to_string();
            let _ = execute_tmux_command(&[
                "resize-window",
                "-t",
                new_window_id,
                "-x",
                &cols_s,
                "-y",
                &rows_s,
            ]);
        }
        let _ = execute_tmux_command(&[
            "set-option",
            "-w",
            "-t",
            new_window_id,
            tmux_options::WINDOW_TYPE,
            WindowType::Tab.as_str(),
        ]);
    }
    Ok(())
}

/// Resize all tmux windows in the session to specific dimensions (columns x rows).
/// This ensures hidden windows (e.g., pane group containers) stay in sync with the viewport.
pub fn resize_window(session_name: &str, cols: u32, rows: u32) -> Result<()> {
    debug!(%session_name, cols, rows, "resize_window");
    let cols_str = cols.to_string();
    let rows_str = rows.to_string();

    // List all window IDs in the session
    let output = execute_tmux_command(&["list-windows", "-t", session_name, "-F", "#{window_id}"])?;

    let window_ids: Vec<&str> = output.trim().lines().filter(|l| !l.is_empty()).collect();
    trace!(?window_ids, "resize_window window ids");
    if window_ids.is_empty() {
        return Ok(());
    }

    // Build a single compound command: resize-window -t @1 -x C -y R \; resize-window -t @2 ...
    let mut args: Vec<&str> = Vec::new();
    for (i, window_id) in window_ids.iter().enumerate() {
        if i > 0 {
            args.push(";");
        }
        args.push("resize-window");
        args.push("-t");
        args.push(window_id);
        args.push("-x");
        args.push(&cols_str);
        args.push("-y");
        args.push(&rows_str);
    }

    trace!(?args, "resize_window executing tmux");
    let result = execute_tmux_command(&args);
    trace!(?result, "resize_window result");
    result?;
    Ok(())
}

/// Get information about all panes in all windows of the session
pub fn get_all_panes_info(session_name: &str) -> Result<Vec<PaneInfo>> {
    // Use comma delimiter (matching control mode state.rs parser).
    // Fields: pane_id, pane_index, pane_left, pane_top, pane_width, pane_height,
    //         cursor_x, cursor_y, pane_active, pane_current_command, pane_title,
    //         pane_in_mode, copy_cursor_x, copy_cursor_y, window_id, history_size,
    //         border_title
    //
    // `history_size` is placed BEFORE `border_title`. The pane title is the only
    // field that can legitimately contain commas (set by the shell / app), so we
    // anchor everything else by position and let the title soak up any remaining
    // commas at the end. Putting `history_size` after the title would mean
    // titles-with-commas could push it out of its expected slot.
    let output = execute_tmux_command(&[
        "list-panes",
        "-s",  // List all panes in all windows of the session (not just active window)
        "-t",
        session_name,
        "-F",
        "#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id},#{history_size},#{T:pane-border-format}",
    ])?;

    let mut panes = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 16 {
            continue;
        }

        // pane_title (index 10) and border_title (last field) are free-text and
        // may contain commas. Anchor on window_id (`@<digits>`), which is
        // immediately preceded by in_mode, copy_cursor_x, copy_cursor_y. Title
        // is everything from index 10 up to those three fields; history_size
        // follows window_id; border_title is the remainder.
        let is_intlike = |s: &str| s.is_empty() || s.parse::<u32>().is_ok();
        let mut title = parts[10].to_string();
        let mut in_mode = parts.get(11).map(|s| *s == "1").unwrap_or(false);
        let mut copy_cursor_x: u32 = parts.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
        let mut copy_cursor_y: u32 = parts.get(13).and_then(|s| s.parse().ok()).unwrap_or(0);
        let mut window_id = parts.get(14).map(|s| s.to_string()).unwrap_or_default();
        let mut history_size: u64 = parts.get(15).and_then(|s| s.parse().ok()).unwrap_or(0);
        let mut border_title = if parts.len() > 16 {
            parts[16..].join(",")
        } else {
            String::new()
        };

        // window_id sits at index >= 14 (command=9, title>=1 field, then
        // in_mode, copy_cursor_x, copy_cursor_y). Scan for the anchor and
        // recompute the surrounding fields when the title shifted them.
        for i in 14..(parts.len() - 1) {
            let val = parts[i];
            if val.starts_with('@')
                && val.len() > 1
                && val[1..].chars().all(|c| c.is_ascii_digit())
                && (parts[i - 3] == "0" || parts[i - 3] == "1")
                && is_intlike(parts[i - 2])
                && is_intlike(parts[i - 1])
            {
                title = parts[10..i - 3].join(",");
                in_mode = parts[i - 3] == "1";
                copy_cursor_x = parts[i - 2].parse().unwrap_or(0);
                copy_cursor_y = parts[i - 1].parse().unwrap_or(0);
                window_id = val.to_string();
                history_size = parts[i + 1].parse().unwrap_or(0);
                border_title = if parts.len() > i + 2 {
                    parts[i + 2..].join(",")
                } else {
                    String::new()
                };
                break;
            }
        }

        let pane = PaneInfo {
            id: parts[0].to_string(),
            index: parts[1].parse().unwrap_or(0),
            x: parts[2].parse().unwrap_or(0),
            y: parts[3].parse().unwrap_or(0),
            width: parts[4].parse().unwrap_or(80),
            height: parts[5].parse().unwrap_or(24),
            cursor_x: parts[6].parse().unwrap_or(0),
            cursor_y: parts[7].parse().unwrap_or(0),
            active: parts[8] == "1",
            command: parts[9].to_string(),
            title,
            border_title,
            in_mode,
            copy_cursor_x,
            copy_cursor_y,
            window_id,
            history_size,
        };

        panes.push(pane);
    }

    Ok(panes)
}

/// Capture content of a specific pane by its ID (e.g., "%0")
pub fn capture_pane_by_id(pane_id: &str) -> Result<String> {
    execute_tmux_command(&["capture-pane", "-t", pane_id, "-p", "-e"])
}

/// Get list of all windows in a session
pub fn get_windows(session_name: &str) -> Result<Vec<WindowInfo>> {
    // Format: window_id,window_index,window_name,window_active
    let output = execute_tmux_command(&[
        "list-windows",
        "-t",
        session_name,
        "-F",
        "#{window_id},#{window_index},#{window_name},#{window_active}",
    ])?;

    let mut windows = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 4 {
            continue;
        }

        windows.push(WindowInfo {
            id: parts[0].to_string(),
            index: parts[1].parse().unwrap_or(0),
            name: parts[2].to_string(),
            active: parts[3] == "1",
        });
    }

    Ok(windows)
}

/// Capture the rendered tmux status line with ANSI escape sequences.
/// Produces a full-width string with spaces between left+windows and right sections,
/// matching tmux's actual rendered status bar output.
pub fn capture_status_line(session_name: &str, width: usize) -> Result<String> {
    // Get status-left-length and status-right-length from tmux options
    let meta = execute_tmux_command(&[
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{status-left-length}\n#{status-right-length}",
    ])?;
    let meta_lines: Vec<&str> = meta.trim_end().lines().collect();
    let max_left_len: usize = meta_lines
        .first()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let max_right_len: usize = meta_lines.get(1).and_then(|s| s.parse().ok()).unwrap_or(50);

    // Get status-left (rendered) - preserve trailing spaces from format
    let left_raw = execute_tmux_command(&[
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{T:status-left}",
    ])?;
    let left_raw = left_raw.trim_end_matches('\n').to_string();

    // Get window list - add separator space after each window format, then trim
    // the trailing one (separator only goes between windows, not after the last)
    let windows_raw = execute_tmux_command(&[
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{W:#{T:window-status-format} ,#{T:window-status-current-format} }",
    ])?;
    let windows_raw = windows_raw
        .trim_end_matches('\n')
        .strip_suffix(' ')
        .unwrap_or(windows_raw.trim_end_matches('\n'))
        .to_string();

    // Get status-right: first get the raw format, evaluate #(cmd) patterns,
    // then pass back through display-message for variable expansion
    let right_format = execute_tmux_command(&[
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{status-right}",
    ])?;
    let right_format = evaluate_shell_commands(right_format.trim_end_matches('\n'));
    let right_raw =
        execute_tmux_command(&["display-message", "-t", session_name, "-p", &right_format])?;
    let right_raw = right_raw.trim_end_matches('\n').to_string();

    // Convert tmux style codes to ANSI and unescape ## → #
    let left_ansi = convert_tmux_style_to_ansi(&left_raw);
    let windows_ansi = convert_tmux_style_to_ansi(&windows_raw);
    let right_ansi = convert_tmux_style_to_ansi(&right_raw);

    // Measure visible lengths (strip ANSI codes)
    let left_visible_len = visible_len(&left_ansi).min(max_left_len);
    let windows_visible_len = visible_len(&windows_ansi);
    let right_visible_len = visible_len(&right_ansi).min(max_right_len);

    // Truncate left/right sections to their max lengths if needed
    let left_ansi = truncate_ansi(&left_ansi, max_left_len);
    let right_ansi = truncate_ansi(&right_ansi, max_right_len);

    // Calculate padding between left+windows and right
    let left_windows_len = left_visible_len + windows_visible_len;
    let padding = if left_windows_len + right_visible_len < width {
        width - left_windows_len - right_visible_len
    } else {
        1 // At least one space separator
    };

    Ok(format!(
        "{}{}{}{}",
        left_ansi,
        windows_ansi,
        " ".repeat(padding),
        right_ansi
    ))
}

/// Evaluate #(cmd) patterns in a tmux format string by running the shell commands
fn evaluate_shell_commands(input: &str) -> String {
    // When attached to a remote server (TMUXY_SSH), the `#(cmd)` snippets come
    // from the REMOTE tmux config and must not run on the local host — doing so
    // produces wrong results at best and executes remote-controlled command
    // strings locally at worst. Skip evaluation (drop the `#(...)` segment)
    // rather than shelling out.
    let allow_local_exec = crate::session::ssh_target().is_none();
    let mut result = String::new();
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '#' && chars.peek() == Some(&'(') {
            chars.next(); // consume '('
            let mut cmd = String::new();
            let mut depth = 1;
            while let Some(&ch) = chars.peek() {
                chars.next();
                if ch == '(' {
                    depth += 1;
                    cmd.push(ch);
                } else if ch == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    cmd.push(ch);
                } else {
                    cmd.push(ch);
                }
            }
            // Execute the command and use its output (local server only).
            if allow_local_exec {
                if let Ok(output) = std::process::Command::new("sh")
                    .arg("-c")
                    .arg(&cmd)
                    .output()
                {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    result.push_str(stdout.trim_end_matches('\n'));
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Calculate visible length of a string (strips ANSI escape codes)
fn visible_len(s: &str) -> usize {
    let mut len = 0;
    let mut in_escape = false;
    for c in s.chars() {
        if in_escape {
            if c == 'm' {
                in_escape = false;
            }
        } else if c == '\x1b' {
            in_escape = true;
        } else {
            len += 1;
        }
    }
    len
}

/// Truncate a string with ANSI codes to a maximum visible length
fn truncate_ansi(s: &str, max_visible: usize) -> String {
    let mut result = String::new();
    let mut visible_count = 0;
    let mut in_escape = false;

    for c in s.chars() {
        if in_escape {
            result.push(c);
            if c == 'm' {
                in_escape = false;
            }
        } else if c == '\x1b' {
            in_escape = true;
            result.push(c);
        } else {
            if visible_count >= max_visible {
                break;
            }
            result.push(c);
            visible_count += 1;
        }
    }

    result
}

/// Convert tmux style codes like #[fg=#89b4fa,bold] to ANSI escape codes.
/// Also unescapes ## → # (tmux's escape for literal # in format output).
fn convert_tmux_style_to_ansi(input: &str) -> String {
    let mut result = String::new();
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '#' {
            match chars.peek() {
                Some(&'[') => {
                    // Parse tmux style code #[...]
                    chars.next(); // consume '['
                    let mut style = String::new();
                    while let Some(&ch) = chars.peek() {
                        if ch == ']' {
                            chars.next();
                            break;
                        }
                        // peek() returned Some, so next() is guaranteed Some.
                        if let Some(c) = chars.next() {
                            style.push(c);
                        }
                    }
                    let ansi = tmux_style_to_ansi(&style);
                    result.push_str(&ansi);
                }
                Some(&'#') => {
                    // ## is tmux's escape for a literal #
                    chars.next(); // consume second '#'
                    result.push('#');
                }
                _ => {
                    result.push(c);
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Convert a single tmux style specification to ANSI escape sequence
fn tmux_style_to_ansi(style: &str) -> String {
    if style.is_empty() || style == "default" {
        return "\x1b[0m".to_string();
    }

    let mut codes = Vec::new();

    for part in style.split(',') {
        let part = part.trim();

        if part == "bold" {
            codes.push("1".to_string());
        } else if part == "dim" {
            codes.push("2".to_string());
        } else if part == "italic" {
            codes.push("3".to_string());
        } else if part == "underscore" || part == "underline" {
            codes.push("4".to_string());
        } else if part == "blink" {
            codes.push("5".to_string());
        } else if part == "reverse" {
            codes.push("7".to_string());
        } else if part == "hidden" {
            codes.push("8".to_string());
        } else if part == "strikethrough" {
            codes.push("9".to_string());
        } else if part == "nobold" || part == "nodim" {
            codes.push("22".to_string());
        } else if part == "noitalic" {
            codes.push("23".to_string());
        } else if part == "nounderscore" || part == "nounderline" {
            codes.push("24".to_string());
        } else if part == "noblink" {
            codes.push("25".to_string());
        } else if part == "noreverse" {
            codes.push("27".to_string());
        } else if part == "nohidden" {
            codes.push("28".to_string());
        } else if part == "nostrikethrough" {
            codes.push("29".to_string());
        } else if let Some(color) = part.strip_prefix("fg=") {
            if let Some(ansi) = color_to_ansi(color, true) {
                codes.push(ansi);
            }
        } else if let Some(color) = part.strip_prefix("bg=") {
            if let Some(ansi) = color_to_ansi(color, false) {
                codes.push(ansi);
            }
        }
    }

    if codes.is_empty() {
        String::new()
    } else {
        format!("\x1b[{}m", codes.join(";"))
    }
}

/// Convert a tmux color specification to ANSI code
fn color_to_ansi(color: &str, is_fg: bool) -> Option<String> {
    let base = if is_fg { 38 } else { 48 };

    if color == "default" {
        return Some(if is_fg {
            "39".to_string()
        } else {
            "49".to_string()
        });
    }

    // Hex color: #RRGGBB
    if let Some(hex) = color.strip_prefix('#') {
        if hex.len() == 6 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                u8::from_str_radix(&hex[0..2], 16),
                u8::from_str_radix(&hex[2..4], 16),
                u8::from_str_radix(&hex[4..6], 16),
            ) {
                return Some(format!("{};2;{};{};{}", base, r, g, b));
            }
        }
    }

    // Color index (0-255)
    if let Ok(idx) = color.parse::<u8>() {
        return Some(format!("{};5;{}", base, idx));
    }

    // Named colors
    let color_code = match color.to_lowercase().as_str() {
        "black" => Some(0),
        "red" => Some(1),
        "green" => Some(2),
        "yellow" => Some(3),
        "blue" => Some(4),
        "magenta" => Some(5),
        "cyan" => Some(6),
        "white" => Some(7),
        "brightblack" => Some(8),
        "brightred" => Some(9),
        "brightgreen" => Some(10),
        "brightyellow" => Some(11),
        "brightblue" => Some(12),
        "brightmagenta" => Some(13),
        "brightcyan" => Some(14),
        "brightwhite" => Some(15),
        _ => None,
    };

    color_code.map(|idx| format!("{};5;{}", base, idx))
}

/// Execute a tmux command string, ensuring it targets the specified session.
/// This function automatically adds session targeting to commands that need it,
/// making it nearly impossible to accidentally affect the wrong session.
///
/// Commands that operate on panes/windows will be targeted to the session.
/// Pane IDs (%N) and window IDs (@N) are validated to belong to the session.
pub fn run_tmux_command_for_session(session_name: &str, cmd: &str) -> Result<String> {
    if cmd.trim().is_empty() {
        return Err(TmuxError::other("Empty command"));
    }

    // Commands that need session targeting if no -t is specified
    const SESSION_TARGETED_COMMANDS: &[&str] = &[
        "select-window",
        "select-pane",
        "split-window",
        "new-window",
        "kill-window",
        "kill-pane",
        "resize-window",
        "resize-pane",
        "swap-pane",
        "swap-window",
        "next-window",
        "previous-window",
        "last-window",
        "last-pane",
        "next-layout",
        "previous-layout",
        "select-layout",
        "rotate-window",
        "break-pane",
        "join-pane",
        "move-pane",
        "move-window",
        "copy-mode",
        "send-keys",
        "send-prefix",
        "capture-pane",
        "display-message",
        "pipe-pane",
        "respawn-pane",
        "respawn-window",
    ];

    // Process compound commands (split by \;)
    let processed_cmd = process_compound_command(session_name, cmd, SESSION_TARGETED_COMMANDS)?;

    // Use shell to handle command parsing. We pass the resolved tmux path
    // (plus -L socket if set) instead of bare `tmux`, because launchd-spawned
    // GUI apps inherit a sparse PATH that does NOT include Homebrew dirs.
    // A bare `tmux` would fail with "command not found" and the user would
    // see typing/operations silently no-op.
    let tmux_bin = crate::session::tmux_bin();
    let output = Command::new("sh")
        .args(["-c", &format!("{} {}", tmux_bin, processed_cmd)])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(TmuxError::other(stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

/// Process a potentially compound tmux command, adding session targeting where needed
fn process_compound_command(
    session_name: &str,
    cmd: &str,
    targeted_commands: &[&str],
) -> Result<String> {
    // Split by \; for compound commands, but be careful with quoted strings
    let parts: Vec<&str> = cmd.split("\\;").collect();

    let mut processed_parts = Vec::new();

    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }

        let processed = add_session_target_if_needed(session_name, part, targeted_commands)?;
        processed_parts.push(processed);
    }

    Ok(processed_parts.join(" \\; "))
}

/// Add session targeting to a single tmux command if needed
fn add_session_target_if_needed(
    session_name: &str,
    cmd: &str,
    targeted_commands: &[&str],
) -> Result<String> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Ok(cmd.to_string());
    }

    let command_name = parts[0];

    // Check if this command needs session targeting
    if !targeted_commands.contains(&command_name) {
        return Ok(cmd.to_string());
    }

    // Check if -t is already specified
    let has_target = parts.contains(&"-t");

    if has_target {
        // Validate and potentially fix existing targets
        return validate_and_fix_target(session_name, cmd, command_name);
    }

    // Add session targeting based on command type
    match command_name {
        "select-window" => {
            // select-window needs session:window format
            // Check if there's a window index/id argument
            if let Some(window_arg) = find_window_arg(&parts) {
                // If it's just a number, prepend session
                if window_arg.parse::<u32>().is_ok() || window_arg.starts_with('@') {
                    let target = format!("{}:{}", session_name, window_arg);
                    return Ok(cmd.replace(&format!(" {}", window_arg), &format!(" -t {}", target)));
                }
            }
            // Default: add -t session_name
            Ok(format!("{} -t {}", cmd, session_name))
        }
        "resize-window" => {
            // resize-window should target the session
            Ok(format!("{} -t {}", cmd, session_name))
        }
        "send-keys" | "send-prefix" => {
            // These often have pane targets, but default to session
            Ok(format!("{} -t {}", cmd, session_name))
        }
        _ => {
            // Default: add -t session_name
            Ok(format!("{} -t {}", cmd, session_name))
        }
    }
}

/// Find a window argument in command parts (index or @id)
fn find_window_arg<'a>(parts: &'a [&'a str]) -> Option<&'a str> {
    // Look for a bare number or @id that's not a flag value
    let mut prev_was_flag = false;
    for part in parts.iter().skip(1) {
        if part.starts_with('-') {
            prev_was_flag = true;
            continue;
        }
        if prev_was_flag {
            prev_was_flag = false;
            continue;
        }
        // This might be a window argument
        if part.parse::<u32>().is_ok() || part.starts_with('@') {
            return Some(part);
        }
    }
    None
}

/// Validate that targets in the command belong to our session, and fix if needed
fn validate_and_fix_target(session_name: &str, cmd: &str, command_name: &str) -> Result<String> {
    // For commands with -t, check if the target includes the session
    // If it's just a pane ID (%N) or window ID (@N), those are global and fine
    // If it's a window index without session (e.g., :1234), prepend the session

    let parts: Vec<&str> = cmd.split_whitespace().collect();
    let mut new_parts: Vec<String> = Vec::new();
    let mut i = 0;

    while i < parts.len() {
        if parts[i] == "-t" && i + 1 < parts.len() {
            let target = parts[i + 1];
            new_parts.push("-t".to_string());

            // Check if target needs session prefix
            let fixed_target = fix_target_session(session_name, target, command_name);
            new_parts.push(fixed_target);
            i += 2;
            continue;
        }
        new_parts.push(parts[i].to_string());
        i += 1;
    }

    Ok(new_parts.join(" "))
}

/// Fix a target string to include session name if needed
fn fix_target_session(session_name: &str, target: &str, command_name: &str) -> String {
    // Pane IDs (%N) and window IDs (@N) are global - don't modify
    if target.starts_with('%') || target.starts_with('@') {
        return target.to_string();
    }

    // If target already has session:window format, leave it
    if target.contains(':') {
        // Target is like ":1234" (current session, window 1234) or "session:window"
        // If it starts with ':', it means "current session" - prepend our session
        if target.starts_with(':') {
            return format!("{}{}", session_name, target);
        }
        // Already has explicit session
        return target.to_string();
    }

    // For window-related commands, bare numbers are window indices
    let window_commands = [
        "select-window",
        "new-window",
        "kill-window",
        "resize-window",
        "swap-window",
        "move-window",
        "link-window",
        "unlink-window",
    ];

    if window_commands.contains(&command_name) {
        // Bare number is a window index - prepend session
        if target.parse::<u32>().is_ok() {
            return format!("{}:{}", session_name, target);
        }
    }

    // Default: return as-is (might be a pane reference or other valid target)
    target.to_string()
}

/// Key binding info returned by get_prefix_bindings
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyBinding {
    pub key: String,
    pub command: String,
    pub description: String,
    /// Whether this binding has the `-r` (repeat) flag.
    /// Repeat bindings auto-re-enter prefix mode after execution.
    #[serde(default)]
    pub repeat: bool,
}

/// Get all prefix key bindings from tmux
pub fn get_prefix_bindings() -> Result<Vec<KeyBinding>> {
    let output = execute_tmux_command(&["list-keys", "-T", "prefix"])?;

    let mut bindings = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        // tmux list-keys output format:
        //   bind-key    -T prefix KEY command...
        //   bind-key -r -T prefix KEY command...
        // The -r flag shifts all subsequent indices by 1.
        let (key_idx, cmd_idx, is_repeat) = if parts.len() >= 6
            && parts[0] == "bind-key"
            && parts[1] == "-r"
            && parts[3] == "prefix"
        {
            (4, 5, true)
        } else if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == "prefix" {
            (3, 4, false)
        } else {
            continue;
        };

        if cmd_idx >= parts.len() {
            continue;
        }

        {
            let bound_key = parts[key_idx];

            // Unescape the key
            let key = if bound_key.starts_with('\\') && bound_key.len() == 2 {
                bound_key[1..].to_string()
            } else {
                bound_key.to_string()
            };

            // Get the command (everything after the key)
            let command = parts[cmd_idx..].join(" ");

            // Generate description based on command
            let description = match parts[cmd_idx] {
                "split-window" => {
                    if command.contains("-h") {
                        "Split pane vertically".to_string()
                    } else {
                        "Split pane horizontally".to_string()
                    }
                }
                "resize-pane" => {
                    if command.contains("-Z") {
                        "Toggle pane fullscreen".to_string()
                    } else {
                        "Resize pane".to_string()
                    }
                }
                "select-pane" => "Select pane".to_string(),
                "last-pane" => "Switch to last active pane".to_string(),
                "next-layout" => "Cycle through pane layouts".to_string(),
                "break-pane" => "Convert pane to window".to_string(),
                "copy-mode" => "Enter copy mode".to_string(),
                "command-prompt" => "Enter command mode".to_string(),
                "new-window" => "Create new window".to_string(),
                "kill-window" => "Close window".to_string(),
                "next-window" => "Next window".to_string(),
                "previous-window" => "Previous window".to_string(),
                "select-window" => "Select window".to_string(),
                _ => command.clone(),
            };

            bindings.push(KeyBinding {
                key,
                command,
                description,
                repeat: is_repeat,
            });
        }
    }

    Ok(bindings)
}

/// Get the tmux prefix key
pub fn get_prefix_key() -> Result<String> {
    let output = execute_tmux_command(&["show-options", "-g", "prefix"])?;
    // Output format: prefix C-a
    if let Some(line) = output.lines().next() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            return Ok(parts[1].to_string());
        }
    }
    Ok("C-b".to_string()) // Default prefix
}

/// Get all root key bindings from tmux (bind -n keybindings)
/// These are keybindings that work without pressing the prefix key first
pub fn get_root_bindings() -> Result<Vec<KeyBinding>> {
    let output = execute_tmux_command(&["list-keys", "-T", "root"])?;

    let mut bindings = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        // Format: bind-key    -T root KEY command...
        //     or: bind-key -r -T root KEY command...
        let (key_idx, cmd_idx) =
            if parts.len() >= 6 && parts[0] == "bind-key" && parts[1] == "-r" && parts[3] == "root"
            {
                (4, 5)
            } else if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == "root" {
                (3, 4)
            } else {
                continue;
            };

        if cmd_idx >= parts.len() {
            continue;
        }

        let bound_key = parts[key_idx];

        // Unescape the key
        let key = if bound_key.starts_with('\\') && bound_key.len() == 2 {
            bound_key[1..].to_string()
        } else {
            bound_key.to_string()
        };

        // Get the command (everything after the key)
        let command = parts[cmd_idx..].join(" ");

        bindings.push(KeyBinding {
            key,
            command,
            description: String::new(),
            repeat: false,
        });
    }

    Ok(bindings)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_pane_info_parsing() {
        let output = "80,24,5,10";
        let parts: Vec<&str> = output.split(',').collect();

        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0].parse::<u32>().unwrap(), 80);
        assert_eq!(parts[1].parse::<u32>().unwrap(), 24);
        assert_eq!(parts[2].parse::<u32>().unwrap(), 5);
        assert_eq!(parts[3].parse::<u32>().unwrap(), 10);
    }

    #[test]
    fn test_capture_pane_parsing() {
        let content = "line1\nline2\nline3".to_string();
        let lines: Vec<String> = content.lines().map(String::from).collect();

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "line1");
        assert_eq!(lines[2], "line3");
    }

    #[test]
    fn test_fix_target_session_pane_id() {
        // Pane IDs should not be modified
        assert_eq!(fix_target_session("tmuxy", "%0", "select-pane"), "%0");
        assert_eq!(fix_target_session("tmuxy", "%123", "swap-pane"), "%123");
    }

    #[test]
    fn test_fix_target_session_window_id() {
        // Window IDs (@N) should not be modified
        assert_eq!(fix_target_session("tmuxy", "@0", "kill-window"), "@0");
        assert_eq!(fix_target_session("tmuxy", "@5", "select-window"), "@5");
    }

    #[test]
    fn test_fix_target_session_colon_prefix() {
        // :N means "window N in current session" - should prepend session
        assert_eq!(
            fix_target_session("tmuxy", ":1234", "new-window"),
            "tmuxy:1234"
        );
        assert_eq!(
            fix_target_session("tmuxy", ":0", "select-window"),
            "tmuxy:0"
        );
    }

    #[test]
    fn test_fix_target_session_explicit_session() {
        // session:window should not be modified
        assert_eq!(
            fix_target_session("tmuxy", "other:0", "new-window"),
            "other:0"
        );
        assert_eq!(
            fix_target_session("tmuxy", "mysession:5", "kill-window"),
            "mysession:5"
        );
    }

    #[test]
    fn test_fix_target_session_bare_number() {
        // Bare numbers for window commands should get session prepended
        assert_eq!(
            fix_target_session("tmuxy", "1234", "new-window"),
            "tmuxy:1234"
        );
        assert_eq!(fix_target_session("tmuxy", "0", "select-window"), "tmuxy:0");
        assert_eq!(fix_target_session("tmuxy", "5", "kill-window"), "tmuxy:5");
    }

    #[test]
    fn test_validate_and_fix_target_new_window() {
        // new-window with :N target should get session prepended
        let result =
            validate_and_fix_target("tmuxy", "new-window -d -t :1234 -n \"test\"", "new-window")
                .unwrap();
        assert_eq!(result, "new-window -d -t tmuxy:1234 -n \"test\"");
    }

    #[test]
    fn test_validate_and_fix_target_select_window() {
        // select-window with bare number should get session prepended
        let result =
            validate_and_fix_target("tmuxy", "select-window -t 5", "select-window").unwrap();
        assert_eq!(result, "select-window -t tmuxy:5");
    }

    #[test]
    fn test_validate_and_fix_target_pane_commands() {
        // Commands with pane IDs should not modify the target
        let result =
            validate_and_fix_target("tmuxy", "swap-pane -s %0 -t %1", "swap-pane").unwrap();
        assert_eq!(result, "swap-pane -s %0 -t %1");
    }
}
