use clap::Args;
use std::io::{self, Write};
use std::path::Path;

#[derive(Args)]
pub struct MdArgs {
    /// Markdown source: file path or "-" for stdin
    pub source: String,
}

pub fn run(args: MdArgs) {
    if let Err(e) = run_inner(args) {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

fn run_inner(args: MdArgs) -> Result<(), String> {
    if args.source == "-" {
        run_stdin()
    } else {
        run_file(&args.source)
    }
}

fn run_stdin() -> Result<(), String> {
    println!("__TMUXY_WIDGET__:markdown");

    let mut content = String::new();
    io::stdin()
        .read_line(&mut content)
        .map_err(|e| format!("Failed to read stdin: {}", e))?;

    println!("__TMUXY_META_START__");
    println!("{}", serde_json::json!({ "content": content }));
    println!("__TMUXY_META_END__");
    io::stdout().flush().ok();

    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

fn run_file(source: &str) -> Result<(), String> {
    let path = Path::new(source);
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to get cwd: {}", e))?
            .join(path)
    };

    if !abs_path.exists() {
        return Err(format!("File not found: {}", abs_path.display()));
    }

    let file_path = abs_path.to_string_lossy().to_string();
    let basename = abs_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    println!("__TMUXY_WIDGET__:markdown");

    let mut last_mtime = get_mtime(&abs_path);
    let mut seq = 0u64;

    output_frame(&basename, &file_path, seq);
    seq += 1;
    io::stdout().flush().ok();

    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let current_mtime = get_mtime(&abs_path);
        if current_mtime != last_mtime {
            last_mtime = current_mtime;
            output_frame(&basename, &file_path, seq);
            seq += 1;
            io::stdout().flush().ok();
        }
    }
}

fn output_frame(basename: &str, file_path: &str, seq: u64) {
    println!("__TITLE__:{}", basename);
    println!("__FILE__:{}", file_path);
    println!("__SEQ__:{}", seq);
}

fn get_mtime(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        })
        .unwrap_or(0)
}
