use std::io::{self, Read, Write};

/// Output the widget marker for the given component name, then pass stdin through.
/// On exit, the pane will clear and start an interactive shell.
#[allow(dead_code)]
pub fn run_widget(component: &str) {
    println!("__TMUXY_WIDGET__:{}", component);

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let mut buf = [0u8; 8192];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).is_err() {
                    break;
                }
                stdout.flush().ok();
            }
            Err(_) => break,
        }
    }

    print!("\x1b[2J\x1b[H");
    io::stdout().flush().ok();

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let shell_cstr = std::ffi::CString::new(shell.as_str()).unwrap();
        nix::unistd::execvp(&shell_cstr, &[&shell_cstr]).ok();
    }
}
