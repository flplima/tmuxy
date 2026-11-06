use tmuxy_core::CommandError;

/// Hand a link or a path to the desktop's default opener. The link was
/// checked first (`host::command::is_openable_url`), so the opener finds
/// nothing to parse in it.
pub(super) fn open_with_system(target: &std::ffi::OsStr) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| CommandError::unavailable(format!("could not open {target:?}: {e}")))
}
