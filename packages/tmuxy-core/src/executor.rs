use std::process::Command;

use crate::DEFAULT_SESSION_NAME;

/// Information about a single pane
#[derive(Debug, Clone)]
pub struct PaneInfo {
    pub id: String,      // e.g., "%0"
    pub index: u32,      // pane index in window
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub active: bool,
    pub command: String, // current running command (e.g., "bash", "vim")
    pub in_mode: bool,   // true if pane is in copy mode
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,
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

pub fn execute_tmux_command(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

pub fn capture_pane(session_name: &str) -> Result<String, String> {
    execute_tmux_command(&[
        "capture-pane",
        "-t",
        session_name,
        "-p", // print to stdout
        "-e", // include escape sequences
    ])
}

pub fn capture_pane_with_history(session_name: &str) -> Result<String, String> {
    execute_tmux_command(&[
        "capture-pane",
        "-t",
        session_name,
        "-p",      // print to stdout
        "-e",      // include escape sequences
        "-S", "-", // Start from history beginning
    ])
}

pub fn send_keys(session_name: &str, keys: &str) -> Result<(), String> {
    execute_tmux_command(&["send-keys", "-t", session_name, keys])?;
    Ok(())
}

pub fn get_pane_info(session_name: &str) -> Result<(u32, u32, u32, u32), String> {
    let output = execute_tmux_command(&[
        "display-message",
        "-t",
        session_name,
        "-p",
        "#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}",
    ])?;

    let parts: Vec<&str> = output.trim().split(',').collect();
    if parts.len() != 4 {
        return Err("Invalid pane info format".to_string());
    }

    let width = parts[0].parse().map_err(|_| "Invalid width")?;
    let height = parts[1].parse().map_err(|_| "Invalid height")?;
    let cursor_x = parts[2].parse().map_err(|_| "Invalid cursor_x")?;
    let cursor_y = parts[3].parse().map_err(|_| "Invalid cursor_y")?;

    Ok((width, height, cursor_x, cursor_y))
}

// Tmux operations
pub fn split_pane_horizontal(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["split-window", "-t", session_name, "-h"])?;
    Ok(())
}

pub fn split_pane_vertical(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["split-window", "-t", session_name, "-v"])?;
    Ok(())
}

pub fn new_window(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["new-window", "-t", session_name])?;
    Ok(())
}

pub fn select_pane(session_name: &str, direction: &str) -> Result<(), String> {
    let dir_flag = match direction {
        "up" | "U" => "-U",
        "down" | "D" => "-D",
        "left" | "L" => "-L",
        "right" | "R" => "-R",
        _ => return Err(format!("Invalid direction: {}", direction)),
    };
    execute_tmux_command(&["select-pane", "-t", session_name, dir_flag])?;
    Ok(())
}

pub fn select_window(session_name: &str, window: &str) -> Result<(), String> {
    let target = format!("{}:{}", session_name, window);
    execute_tmux_command(&["select-window", "-t", &target])?;
    Ok(())
}

pub fn next_window(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["next-window", "-t", session_name])?;
    Ok(())
}

pub fn previous_window(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["previous-window", "-t", session_name])?;
    Ok(())
}

pub fn kill_pane(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["kill-pane", "-t", session_name])?;
    Ok(())
}

// Convenience functions using default session name
pub fn capture_pane_default() -> Result<String, String> {
    capture_pane(DEFAULT_SESSION_NAME)
}

pub fn capture_pane_with_history_default() -> Result<String, String> {
    capture_pane_with_history(DEFAULT_SESSION_NAME)
}

pub fn send_keys_default(keys: &str) -> Result<(), String> {
    send_keys(DEFAULT_SESSION_NAME, keys)
}

pub fn get_pane_info_default() -> Result<(u32, u32, u32, u32), String> {
    get_pane_info(DEFAULT_SESSION_NAME)
}

pub fn split_pane_horizontal_default() -> Result<(), String> {
    split_pane_horizontal(DEFAULT_SESSION_NAME)
}

pub fn split_pane_vertical_default() -> Result<(), String> {
    split_pane_vertical(DEFAULT_SESSION_NAME)
}

pub fn new_window_default() -> Result<(), String> {
    new_window(DEFAULT_SESSION_NAME)
}

pub fn select_pane_default(direction: &str) -> Result<(), String> {
    select_pane(DEFAULT_SESSION_NAME, direction)
}

pub fn select_window_default(window: &str) -> Result<(), String> {
    select_window(DEFAULT_SESSION_NAME, window)
}

pub fn next_window_default() -> Result<(), String> {
    next_window(DEFAULT_SESSION_NAME)
}

pub fn previous_window_default() -> Result<(), String> {
    previous_window(DEFAULT_SESSION_NAME)
}

pub fn kill_pane_default() -> Result<(), String> {
    kill_pane(DEFAULT_SESSION_NAME)
}

/// Select a specific pane by its ID (e.g., "%0", "%1")
pub fn select_pane_by_id(pane_id: &str) -> Result<(), String> {
    execute_tmux_command(&["select-pane", "-t", pane_id])?;
    Ok(())
}

pub fn select_pane_by_id_default(pane_id: &str) -> Result<(), String> {
    select_pane_by_id(pane_id)
}

/// Scroll a pane up or down
pub fn scroll_pane(pane_id: &str, direction: &str, amount: u32) -> Result<(), String> {
    // Enter copy mode and scroll
    execute_tmux_command(&["copy-mode", "-t", pane_id])?;

    let scroll_cmd = match direction {
        "up" => format!("send-keys -t {} -X scroll-up", pane_id),
        "down" => format!("send-keys -t {} -X scroll-down", pane_id),
        _ => return Err(format!("Invalid scroll direction: {}", direction)),
    };

    // Execute scroll command multiple times based on amount
    for _ in 0..amount {
        let args: Vec<&str> = scroll_cmd.split_whitespace().collect();
        execute_tmux_command(&args)?;
    }

    Ok(())
}

pub fn scroll_pane_default(pane_id: &str, direction: &str, amount: u32) -> Result<(), String> {
    scroll_pane(pane_id, direction, amount)
}

/// Send mouse event to tmux pane
/// event_type: "press", "release", "drag"
/// button: 0 = left, 1 = middle, 2 = right, 64 = scroll up, 65 = scroll down
/// x, y: terminal cell coordinates (0-indexed)
pub fn send_mouse_event(pane_id: &str, event_type: &str, button: u32, x: u32, y: u32) -> Result<(), String> {
    // tmux uses SGR mouse encoding (mode 1006)
    // Format: \e[<Cb;Cx;CyM for press/drag, \e[<Cb;Cx;Cym for release
    // Cb = button number (0=left, 1=middle, 2=right, 32+=motion, 64+=scroll)
    let cb = match event_type {
        "drag" => button + 32,
        _ => button,
    };

    let suffix = match event_type {
        "release" => "m",
        _ => "M",
    };

    // SGR coordinates are 1-indexed
    let seq = format!("\x1b[<{};{};{}{}", cb, x + 1, y + 1, suffix);

    // Send the escape sequence as literal keys
    execute_tmux_command(&["send-keys", "-t", pane_id, "-l", &seq])?;
    Ok(())
}

pub fn send_mouse_event_default(pane_id: &str, event_type: &str, button: u32, x: u32, y: u32) -> Result<(), String> {
    send_mouse_event(pane_id, event_type, button, x, y)
}

/// Resize a pane by a relative amount
/// direction: "L" (left/shrink width), "R" (right/grow width), "U" (up/shrink height), "D" (down/grow height)
/// adjustment: number of cells to adjust
pub fn resize_pane(pane_id: &str, direction: &str, adjustment: u32) -> Result<(), String> {
    let dir_flag = match direction {
        "L" | "left" => "-L",
        "R" | "right" => "-R",
        "U" | "up" => "-U",
        "D" | "down" => "-D",
        _ => return Err(format!("Invalid resize direction: {}", direction)),
    };
    execute_tmux_command(&[
        "resize-pane",
        "-t",
        pane_id,
        dir_flag,
        &adjustment.to_string(),
    ])?;
    Ok(())
}

pub fn resize_pane_default(pane_id: &str, direction: &str, adjustment: u32) -> Result<(), String> {
    resize_pane(pane_id, direction, adjustment)
}

/// Resize the entire tmux window to specific dimensions (columns x rows)
pub fn resize_window(session_name: &str, cols: u32, rows: u32) -> Result<(), String> {
    execute_tmux_command(&[
        "resize-window",
        "-t",
        session_name,
        "-x",
        &cols.to_string(),
        "-y",
        &rows.to_string(),
    ])?;
    Ok(())
}

pub fn resize_window_default(cols: u32, rows: u32) -> Result<(), String> {
    resize_window(DEFAULT_SESSION_NAME, cols, rows)
}

/// Get information about all panes in the current window
pub fn get_all_panes_info(session_name: &str) -> Result<Vec<PaneInfo>, String> {
    // Format: pane_id,pane_index,pane_left,pane_top,pane_width,pane_height,cursor_x,cursor_y,pane_active,pane_current_command,pane_in_mode,copy_cursor_x,copy_cursor_y
    let output = execute_tmux_command(&[
        "list-panes",
        "-t",
        session_name,
        "-F",
        "#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y}",
    ])?;

    let mut panes = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() != 13 {
            continue;
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
            in_mode: parts[10] == "1",
            copy_cursor_x: parts[11].parse().unwrap_or(0),
            copy_cursor_y: parts[12].parse().unwrap_or(0),
        };

        panes.push(pane);
    }

    Ok(panes)
}

/// Capture content of a specific pane by its ID (e.g., "%0")
pub fn capture_pane_by_id(pane_id: &str) -> Result<String, String> {
    execute_tmux_command(&[
        "capture-pane",
        "-t",
        pane_id,
        "-p",
        "-e",
    ])
}

/// Get list of all windows in a session
pub fn get_windows(session_name: &str) -> Result<Vec<WindowInfo>, String> {
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

pub fn get_windows_default() -> Result<Vec<WindowInfo>, String> {
    get_windows(DEFAULT_SESSION_NAME)
}

/// Close/kill the current window
pub fn kill_window(session_name: &str) -> Result<(), String> {
    execute_tmux_command(&["kill-window", "-t", session_name])?;
    Ok(())
}

pub fn kill_window_default() -> Result<(), String> {
    kill_window(DEFAULT_SESSION_NAME)
}

/// Execute a raw tmux command string
/// Supports compound commands with \; separator (e.g., "swap-pane -s %0 -t %1 \; select-layout main-vertical")
pub fn run_tmux_command(cmd: &str) -> Result<String, String> {
    run_tmux_command_for_session(DEFAULT_SESSION_NAME, cmd)
}

/// Execute a tmux command string, ensuring it targets the specified session.
/// This function automatically adds session targeting to commands that need it,
/// making it nearly impossible to accidentally affect the wrong session.
///
/// Commands that operate on panes/windows will be targeted to the session.
/// Pane IDs (%N) and window IDs (@N) are validated to belong to the session.
pub fn run_tmux_command_for_session(session_name: &str, cmd: &str) -> Result<String, String> {
    if cmd.trim().is_empty() {
        return Err("Empty command".to_string());
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

    // Use shell to handle command parsing
    let output = Command::new("sh")
        .args(["-c", &format!("tmux {}", processed_cmd)])
        .output()
        .map_err(|e| format!("Failed to execute tmux: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
}

/// Process a potentially compound tmux command, adding session targeting where needed
fn process_compound_command(session_name: &str, cmd: &str, targeted_commands: &[&str]) -> Result<String, String> {
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
fn add_session_target_if_needed(session_name: &str, cmd: &str, targeted_commands: &[&str]) -> Result<String, String> {
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
    let has_target = parts.iter().any(|&p| p == "-t");

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
fn validate_and_fix_target(session_name: &str, cmd: &str, command_name: &str) -> Result<String, String> {
    // For commands with -t, check if the target includes the session
    // If it's just a pane ID (%N) or window ID (@N), those are global and fine
    // If it's a window index without session, prepend the session

    let mut result = cmd.to_string();

    // Special handling for select-window with -t index
    if command_name == "select-window" {
        // Pattern: select-window -t N (where N is just a number)
        let re_pattern = format!(r"-t\s+(\d+)(?:\s|$)");
        if let Ok(re) = regex::Regex::new(&re_pattern) {
            if let Some(caps) = re.captures(&result) {
                if let Some(m) = caps.get(1) {
                    let window_idx = m.as_str();
                    let new_target = format!("{}:{}", session_name, window_idx);
                    result = result.replace(&format!("-t {}", window_idx), &format!("-t {}", new_target));
                }
            }
        }
    }

    // For resize-window, if target is just a number, prepend session
    if command_name == "resize-window" {
        // Check if -t value is just a number (window index) instead of session:window
        let parts: Vec<&str> = result.split_whitespace().collect();
        let mut new_parts: Vec<String> = Vec::new();
        let mut i = 0;
        while i < parts.len() {
            if parts[i] == "-t" && i + 1 < parts.len() {
                let target = parts[i + 1];
                // If target doesn't contain ':' and isn't a % or @ reference
                if !target.contains(':') && !target.starts_with('%') && !target.starts_with('@') {
                    new_parts.push("-t".to_string());
                    new_parts.push(format!("{}:{}", session_name, target));
                    i += 2;
                    continue;
                }
            }
            new_parts.push(parts[i].to_string());
            i += 1;
        }
        result = new_parts.join(" ");
    }

    Ok(result)
}

/// Execute a prefix key binding by looking up the binding in tmux and executing it
pub fn execute_prefix_binding(session_name: &str, key: &str) -> Result<(), String> {
    // Query tmux for the binding in the prefix table
    // Format: bind-key [-T key-table] key command [arguments]
    // We need to look up bindings in the prefix table
    let output = execute_tmux_command(&[
        "list-keys",
        "-T",
        "prefix",
    ])?;

    // Parse the output to find the binding for this key
    // Format: bind-key -T prefix h select-pane -L
    for line in output.lines() {
        // Parse the line to extract the key and command
        // Example: bind-key -T prefix h select-pane -L
        let parts: Vec<&str> = line.split_whitespace().collect();

        if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == "prefix" {
            let bound_key = parts[3];

            // Unescape the bound key (tmux escapes special chars like " % $)
            let unescaped_key = if bound_key.starts_with('\\') && bound_key.len() == 2 {
                &bound_key[1..]
            } else {
                bound_key
            };

            // Match the key
            if unescaped_key == key {
                // Found the binding, extract and execute the command
                let command_parts: Vec<&str> = parts[4..].to_vec();

                if command_parts.is_empty() {
                    return Err(format!("Empty command for key: {}", key));
                }

                // Build the tmux command with target session
                let mut args = command_parts.clone();

                // Add target session for commands that need it
                let cmd = command_parts[0];
                match cmd {
                    "select-pane" | "split-window" | "new-window" | "kill-pane"
                    | "next-window" | "previous-window" | "select-window"
                    | "resize-pane" | "break-pane" | "next-layout" | "last-pane" => {
                        // Check if -t is already specified
                        if !args.contains(&"-t") {
                            args.push("-t");
                            args.push(session_name);
                        }
                    }
                    "copy-mode" | "send-prefix" | "command-prompt" => {
                        if !args.contains(&"-t") {
                            args.push("-t");
                            args.push(session_name);
                        }
                    }
                    "source-file" => {
                        // source-file doesn't need a target
                    }
                    _ => {
                        // For other commands, try adding target if not present
                        if !args.contains(&"-t") {
                            args.push("-t");
                            args.push(session_name);
                        }
                    }
                }

                execute_tmux_command(&args)?;
                return Ok(());
            }
        }
    }

    // No binding found - send the key as-is (like tmux would)
    // First send the prefix, then the key
    Err(format!("No prefix binding found for key: {}", key))
}

pub fn execute_prefix_binding_default(key: &str) -> Result<(), String> {
    execute_prefix_binding(crate::DEFAULT_SESSION_NAME, key)
}

/// Key binding info returned by get_prefix_bindings
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyBinding {
    pub key: String,
    pub command: String,
    pub description: String,
}

/// Get all prefix key bindings from tmux
pub fn get_prefix_bindings() -> Result<Vec<KeyBinding>, String> {
    let output = execute_tmux_command(&["list-keys", "-T", "prefix"])?;

    let mut bindings = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == "prefix" {
            let bound_key = parts[3];

            // Unescape the key
            let key = if bound_key.starts_with('\\') && bound_key.len() == 2 {
                bound_key[1..].to_string()
            } else {
                bound_key.to_string()
            };

            // Get the command (everything after the key)
            let command = parts[4..].join(" ");

            // Generate description based on command
            let description = match parts[4] {
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
            });
        }
    }

    Ok(bindings)
}

/// Get the tmux prefix key
pub fn get_prefix_key() -> Result<String, String> {
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

#[cfg(test)]
mod tests {
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
}
