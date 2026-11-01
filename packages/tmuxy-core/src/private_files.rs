//! Files and directories only their owner can read, for what records a
//! user's work: session snapshots (cwds, argv, scrollback), the app's managed
//! state and trace preferences. On Unix a directory is `0700` and a file
//! `0600`, whatever the umask, including one an older build left looser.

use std::io;
use std::path::Path;

/// `create_dir_all`, with the leaf directory owner-only.
pub fn create_dir_all(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// `std::fs::write`, owner-only, refusing symlinks at the target path.
pub fn write(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents.as_ref())
}

/// Open or create a file for appending, owner-only (`0600`), refusing symlinks.
pub fn open_append(path: &Path) -> io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_directory_and_a_file_are_owner_only_even_when_they_existed_looser() {
        let root = std::env::temp_dir().join(format!("tmuxy-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("state");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = dir.join("snapshot.json");
        std::fs::write(&file, "old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();

        super::create_dir_all(&dir).unwrap();
        super::write(&file, "new").unwrap();

        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&file), 0o600);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");

        let target = dir.join("target.txt");
        std::fs::write(&target, "keep").unwrap();
        let link = dir.join("symlink.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(super::write(&link, "overwrite").is_err());
        assert!(super::open_append(&link).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");

        let appended = dir.join("trace.ndjson");
        std::fs::write(&appended, "").unwrap();
        std::fs::set_permissions(&appended, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _f = super::open_append(&appended).unwrap();
        assert_eq!(mode(&appended), 0o600);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
