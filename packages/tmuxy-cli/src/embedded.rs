use rust_embed::Embed;
use std::path::PathBuf;

#[derive(Embed)]
#[folder = "scripts/tmuxy/"]
pub struct Scripts;

/// Get the directory where extracted scripts are stored
pub fn scripts_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".tmuxy")
        .join("scripts")
}

/// Extract embedded scripts to ~/.tmuxy/scripts/ if missing or outdated.
pub fn ensure_scripts_extracted() {
    let dir = scripts_dir();
    std::fs::create_dir_all(&dir).ok();

    // Compute a hash of all embedded scripts
    let mut hasher_input = String::new();
    for filename in Scripts::iter() {
        if let Some(file) = Scripts::get(&filename) {
            hasher_input.push_str(&filename);
            hasher_input.push(':');
            hasher_input.push_str(&format!("{}", file.data.len()));
            hasher_input.push('\n');
        }
    }
    let current_hash = simple_hash(&hasher_input);

    // Check if hash matches existing extraction
    let hash_file = dir.join(".scripts_hash");
    if let Ok(existing_hash) = std::fs::read_to_string(&hash_file) {
        if existing_hash.trim() == current_hash {
            return;
        }
    }

    // Extract all scripts
    for filename in Scripts::iter() {
        if let Some(file) = Scripts::get(&filename) {
            let target = dir.join(filename.as_ref());
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(&target, file.data.as_ref()).ok();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).ok();
            }
        }
    }

    std::fs::write(&hash_file, &current_hash).ok();
}

fn simple_hash(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut hash: u64 = bytes.len() as u64;
    for (i, &b) in bytes.iter().enumerate() {
        hash = hash.wrapping_mul(31).wrapping_add(b as u64).wrapping_add(i as u64);
    }
    format!("{:016x}", hash)
}
