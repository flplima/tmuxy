use clap::Args;
use std::io::{self, Read, Write};
use std::path::Path;

#[derive(Args)]
pub struct ImageArgs {
    /// Image source: file path or URL
    pub source: String,
}

pub fn run(args: ImageArgs) {
    if let Err(e) = run_inner(args) {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

fn run_inner(args: ImageArgs) -> Result<(), String> {
    let source = &args.source;

    // Resolve file path to absolute
    let resolved = if source.starts_with("http://") || source.starts_with("https://") {
        source.clone()
    } else {
        let path = Path::new(source);
        let abs = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| format!("Failed to get cwd: {}", e))?
                .join(path)
        };
        if !abs.exists() {
            return Err(format!("File not found: {}", abs.display()));
        }
        abs.to_string_lossy().to_string()
    };

    // Output widget marker + metadata
    println!("__TMUXY_WIDGET__:image");
    println!("__TMUXY_META_START__");
    println!("{}", serde_json::json!({ "src": resolved }));
    println!("__TMUXY_META_END__");
    io::stdout().flush().ok();

    // Block until stdin closes (pane is closed)
    let mut buf = [0u8; 1024];
    loop {
        match io::stdin().read(&mut buf) {
            Ok(0) | Err(_) => break,
            _ => {}
        }
    }

    // Clear screen and exec shell
    print!("\x1b[2J\x1b[H");
    io::stdout().flush().ok();

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let shell_cstr = std::ffi::CString::new(shell.as_str()).unwrap();
        nix::unistd::execvp(&shell_cstr, &[&shell_cstr]).ok();
    }

    Ok(())
}
