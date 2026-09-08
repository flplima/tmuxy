use tracing::{debug, trace};

use crate::error::TmuxError;
use crate::WindowType;

type Result<T> = std::result::Result<T, TmuxError>;

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

/// Resize all tmux windows in the session to specific dimensions (columns x rows).
/// This ensures hidden windows (e.g., pane group containers) stay in sync with the viewport.
///
/// The two sidebar windows are the exception: they are docked *beside* the pane
/// grid rather than behind it, so each takes its own [`sidebar_dock`] column
/// width (keeping the viewport's rows). See the mirror of this rule in
/// `control_mode::monitor::apply_client_size`.
pub fn resize_window(session_name: &str, cols: u32, rows: u32) -> Result<()> {
    debug!(%session_name, cols, rows, "resize_window");
    let cols_str = cols.to_string();
    let rows_str = rows.to_string();

    // List every window with its tmuxy type and any dragged column width, so the
    // sidebars can be told apart and sized to what the user actually set.
    let format = format!(
        "#{{window_id}},#{{{}}},#{{{}}},#{{{}}}",
        crate::constants::tmux_options::WINDOW_TYPE,
        crate::constants::tmux_options::SIDEBAR_COLS,
        crate::constants::tmux_options::SIDEBAR_ROWS
    );
    let output =
        execute_tmux_command(&["list-windows", "-t", session_name, "-F", format.as_str()])?;

    // (window_id, column width for a sidebar — None means viewport-sized,
    //  rows the dock holds — None means the viewport's)
    let windows: Vec<(&str, Option<u32>, Option<u32>)> = output
        .trim()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut fields = line.split(',');
            let id = fields.next().unwrap_or(line);
            let kind = fields.next().unwrap_or("");
            let user_cols = fields.next().and_then(|c| c.parse::<u32>().ok());
            let user_rows = fields.next().and_then(|c| c.parse::<u32>().ok());
            let cols = WindowType::parse(kind)
                .and_then(|t| crate::constants::sidebar_dock::cols(t, user_cols));
            (id, cols, cols.and(user_rows))
        })
        .collect();
    trace!(?windows, "resize_window window ids");
    if windows.is_empty() {
        return Ok(());
    }

    // Build a single compound command: resize-window -t @1 -x C -y R \; resize-window -t @2 ...
    let mut args: Vec<&str> = Vec::new();
    // Owns the per-sidebar size strings for the lifetime of `args`.
    let sidebar_strs: Vec<(Option<String>, Option<String>)> = windows
        .iter()
        .map(|(_, cols, rows)| {
            (
                cols.map(|c| c.to_string()),
                rows.map(|r| r.max(1).to_string()),
            )
        })
        .collect();
    for (i, ((window_id, _, _), (sidebar_cols_str, sidebar_rows_str))) in
        windows.iter().zip(sidebar_strs.iter()).enumerate()
    {
        if i > 0 {
            args.push(";");
        }
        args.push("resize-window");
        args.push("-t");
        args.push(window_id);
        args.push("-x");
        args.push(sidebar_cols_str.as_deref().unwrap_or(&cols_str));
        args.push("-y");
        args.push(sidebar_rows_str.as_deref().unwrap_or(&rows_str));
    }

    trace!(?args, "resize_window executing tmux");
    let result = execute_tmux_command(&args);
    trace!(?result, "resize_window result");
    result?;
    Ok(())
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

/// Single-quote a value for interpolation into a tmux command string.
///
/// Session names come from `servers.json` and the connect form, so they can
/// contain whitespace (which would silently truncate the target) or `;`
/// (which would append extra commands to the list).
pub fn tmux_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Build the `new-window` rewrite: `new-window`/`neww` crashes tmux 3.5a with
/// control mode attached, so both transports send `splitw ; breakp` instead.
///
/// `resizew` targets the current window, which is the new one after `breakp`,
/// so the new window matches the viewport at creation rather than inheriting
/// the half-width post-split size or the control-mode PTY default.
///
/// Shared by the SSE server and the Tauri app so the rewrite shape can't drift
/// between transports. Tabs carry no marker (an untagged window is a tab), so
/// there is nothing to tag.
pub fn new_window_rewrite(session: &str, size: Option<(u32, u32)>) -> String {
    let session = tmux_quote(session);
    match size {
        Some((cols, rows)) => {
            format!("splitw -t {session} ; breakp ; resizew -x {cols} -y {rows}")
        }
        None => format!("splitw -t {session} ; breakp"),
    }
}

/// The verb of a single tmux command — its first whitespace-delimited token.
pub(crate) fn command_verb(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

/// Does any command in a (possibly compound) command list use one of `verbs`?
///
/// The keyboard actor prepends `select-window -t @N \; select-pane -t %N \;`
/// to every bound command, so a binding arrives as a compound whose FIRST
/// command is the pin. Any interception written as
/// `command.starts_with("<verb>")` silently stops matching the moment a
/// binding is pinned — the guard is still there, it just never fires again.
/// Ask about the whole list instead.
pub fn compound_has_verb(command: &str, verbs: &[&str]) -> bool {
    split_compound(command)
        .iter()
        .any(|part| verbs.contains(&command_verb(part)))
}

/// Rewrite a `new-window` sitting anywhere in a (possibly pinned) command list,
/// leaving the commands around it — the keyboard actor's window/pane pin — in
/// place.
///
/// Without this, `prefix c` (`select-window … \; select-pane … \; new-window`)
/// misses the `starts_with("new-window")` intercept and the raw `new-window`
/// runs as an external subprocess against an attached control-mode client:
/// the exact crash the rewrite exists to prevent (see docs/TMUX.md).
///
/// Keeping the pin matters beyond the crash. `splitw -t <session>` targets the
/// session's *current* window, so the pin ahead of it is what makes the new tab
/// come from the window the user is actually looking at rather than whichever
/// one tmux last considered current.
///
/// Returns `None` when the list contains no `new-window`.
pub fn rewrite_new_window_in_compound(
    command: &str,
    session: &str,
    size: Option<(u32, u32)>,
) -> Option<String> {
    let mut found = false;
    let parts: Vec<String> = split_compound(command)
        .iter()
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }
            if !found && matches!(command_verb(trimmed), "new-window" | "neww") {
                found = true;
                return Some(new_window_rewrite(session, size));
            }
            Some(trimmed.to_string())
        })
        .collect();

    // Bare `;` on purpose: control mode's line parser rejects the shell-escaped
    // `\;` the frontend joins with, and the monitor's unescape only rewrites
    // the form it already knows.
    found.then(|| parts.join(" ; "))
}

/// Split a compound tmux command on the `\;` separators that are *outside*
/// quotes.
///
/// A plain `cmd.split("\\;")` also splits inside quoted payloads, so
/// `send-keys -l 'a\;b'` was torn into two bogus commands.
pub(crate) fn split_compound(cmd: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                current.push(c);
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push(c);
            }
            '\\' if !in_single && !in_double && chars.peek() == Some(&';') => {
                chars.next();
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts
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
    Ok(parse_bindings("prefix", &output))
}

/// Parse `tmux list-keys -T <table>` output into `KeyBinding`s.
///
/// One parser for every table — the prefix and root paths used to carry
/// separate copies, and the root copy computed the `-r` indices but then
/// hardcoded `repeat: false`, silently losing repeat bindings.
fn parse_bindings(table: &str, output: &str) -> Vec<KeyBinding> {
    let mut bindings = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        // tmux list-keys output format:
        //   bind-key    -T <table> KEY command...
        //   bind-key -r -T <table> KEY command...
        // The -r flag shifts all subsequent indices by 1.
        let (key_idx, cmd_idx, is_repeat) = if parts.len() >= 6
            && parts[0] == "bind-key"
            && parts[1] == "-r"
            && parts[3] == table
        {
            (4, 5, true)
        } else if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == table {
            (3, 4, false)
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
        let description = describe_binding(parts[cmd_idx], &command);

        bindings.push(KeyBinding {
            key,
            command,
            description,
            repeat: is_repeat,
        });
    }

    bindings
}

/// Human description for the common commands the menus surface.
fn describe_binding(command_name: &str, command: &str) -> String {
    match command_name {
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
        _ => command.to_string(),
    }
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
    Ok(parse_bindings("root", &output))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {

    use super::*;

    // NOTE: the previous two tests here (`test_pane_info_parsing`,
    // `test_capture_pane_parsing`) split a literal string and asserted the
    // split — they exercised `str::split`/`str::lines`, not this module.
    // Replaced with coverage of the actual parsing helpers below.

    #[test]
    fn parse_bindings_handles_plain_and_repeat_forms() {
        let output = "\
bind-key    -T prefix % split-window -h
bind-key -r -T prefix h resize-pane -L 5
bind-key    -T root C-Left select-pane -L
bind-key    -T prefix \\% send-keys %";
        let prefix = parse_bindings("prefix", output);
        assert_eq!(prefix.len(), 3);
        assert_eq!(prefix[0].key, "%");
        assert_eq!(prefix[0].description, "Split pane vertically");
        assert!(!prefix[0].repeat);
        // -r bindings keep their repeat flag (the old root copy hardcoded
        // repeat: false — this drift is what the shared parser fixes).
        assert_eq!(prefix[1].key, "h");
        assert!(prefix[1].repeat);
        // Escaped keys are unescaped.
        assert_eq!(prefix[2].key, "%");

        let root = parse_bindings("root", output);
        assert_eq!(root.len(), 1);
        assert_eq!(root[0].key, "C-Left");
        assert_eq!(root[0].description, "Select pane");
    }

    #[test]
    fn new_window_rewrite_quotes_the_session() {
        // Session names come from servers.json / the connect form, so they can
        // contain whitespace (which truncated the target) or `;` (which
        // appended extra commands to the list).
        let out = new_window_rewrite("my session", None);
        assert!(out.contains("splitw -t 'my session' ;"), "{out}");

        let out = new_window_rewrite("evil ; kill-server", None);
        assert!(out.contains("-t 'evil ; kill-server'"), "{out}");

        let out = new_window_rewrite("it's", None);
        assert!(out.contains(r"-t 'it'\''s'"), "{out}");
    }

    #[test]
    fn new_window_rewrite_includes_resize_only_with_a_size() {
        let sized = new_window_rewrite("tmuxy", Some((120, 40)));
        assert!(sized.contains("resizew -x 120 -y 40"), "{sized}");
        // Tabs carry no marker — the rewrite must not tag the window.
        assert!(!sized.contains("@tmuxy-window-type"), "{sized}");

        let plain = new_window_rewrite("tmuxy", None);
        assert!(!plain.contains("resizew"), "{plain}");
        assert!(!plain.contains("@tmuxy-window-type"), "{plain}");
    }

    /// The regression this pair of helpers exists for: the keyboard actor pins
    /// every bound command, so `prefix c` never looked like a `new-window` to a
    /// head-anchored check, and the raw command escaped to an external
    /// subprocess against an attached control-mode client.
    #[test]
    fn compound_has_verb_sees_past_the_binding_pin() {
        let pinned =
            "select-window -t @2 \\; select-pane -t %5 \\; new-window -c \"#{pane_current_path}\"";
        assert!(compound_has_verb(pinned, &["new-window", "neww"]));
        assert!(compound_has_verb("neww", &["new-window", "neww"]));
        // A pane pin alone (an overlay binding) is still seen through.
        assert!(compound_has_verb(
            "select-pane -t %5 \\; neww",
            &["new-window", "neww"]
        ));
        // No false positives: `new-window` as an argument is not a verb, and a
        // different command with the same prefix does not count.
        assert!(!compound_has_verb(
            "select-pane -t %5 \\; split-window -h",
            &["new-window", "neww"]
        ));
        assert!(!compound_has_verb(
            "send-keys -l 'new-window'",
            &["new-window", "neww"]
        ));
    }

    #[test]
    fn rewrite_new_window_in_compound_keeps_the_pin_around_the_rewrite() {
        let pinned = "select-window -t @2 \\; select-pane -t %5 \\; new-window";
        let out = rewrite_new_window_in_compound(pinned, "tmuxy", Some((120, 40)))
            .expect("a new-window in the list");

        // The pin survives, ahead of the rewrite — `splitw -t <session>` targets
        // the session's CURRENT window, so the pin is what aims it at the tab
        // the user is looking at.
        assert!(
            out.starts_with("select-window -t @2 ; select-pane -t %5 ;"),
            "{out}"
        );
        assert!(out.contains("splitw -t 'tmuxy'"), "{out}");
        assert!(out.contains("breakp"), "{out}");
        assert!(out.contains("resizew -x 120 -y 40"), "{out}");
        // Control mode's line parser rejects the shell-escaped separator.
        assert!(!out.contains("\\;"), "{out}");
    }

    #[test]
    fn rewrite_new_window_in_compound_passes_through_unpinned_and_unrelated() {
        let bare = rewrite_new_window_in_compound("new-window", "tmuxy", None)
            .expect("a bare new-window still rewrites");
        assert_eq!(bare, new_window_rewrite("tmuxy", None));

        assert!(rewrite_new_window_in_compound(
            "select-pane -t %5 \\; split-window -h",
            "tmuxy",
            None
        )
        .is_none());
    }

    #[test]
    fn split_compound_respects_quotes() {
        // Unquoted separators split.
        assert_eq!(
            split_compound("splitw \\; breakp"),
            vec!["splitw ".to_string(), " breakp".to_string()]
        );
        // A separator inside single quotes is payload, not a separator.
        assert_eq!(
            split_compound("send-keys -l 'a\\;b'"),
            vec!["send-keys -l 'a\\;b'".to_string()]
        );
        // Same for double quotes.
        assert_eq!(
            split_compound("send-keys -l \"a\\;b\""),
            vec!["send-keys -l \"a\\;b\"".to_string()]
        );
        // Mixed: quoted payload preserved, real separator still splits.
        assert_eq!(
            split_compound("send-keys -l 'a\\;b' \\; selectp -t %1"),
            vec![
                "send-keys -l 'a\\;b' ".to_string(),
                " selectp -t %1".to_string()
            ]
        );
    }
}
