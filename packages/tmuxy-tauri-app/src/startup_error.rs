//! The dialog a desktop launch ends in when tmuxy cannot start (no tmux, or
//! one too old) — shown before any window opens, and blocking until it is
//! dismissed, so an app launched from a menu says why instead of vanishing.

const TITLE: &str = "tmuxy can't start";

/// Show `message` in a native error dialog and wait for it to be dismissed.
#[cfg(target_os = "linux")]
pub(crate) fn show(message: &str) {
    use gtk::prelude::*;

    // GTK directly, on the main thread tauri's event loop already initialized
    // it on. rfd's Linux backends either run `zenity` (missing on minimal
    // desktops, and the dialog silently never appears) or drive GTK from a
    // thread of their own, which deadlocks against the event loop this setup
    // hook is blocking.
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Error,
        gtk::ButtonsType::Ok,
        TITLE,
    );
    dialog.set_title(TITLE);
    dialog.set_secondary_text(Some(message));
    dialog.run();
    dialog.close();
}

/// Show `message` in a native error dialog and wait for it to be dismissed.
#[cfg(not(target_os = "linux"))]
pub(crate) fn show(message: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(TITLE)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
