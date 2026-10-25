//! Trackpad slide phases for the page (docs/DESKTOP.md § Trackpad gestures).
//!
//! A page cannot tell when the fingers leave a trackpad: a two-finger slide
//! reaches it as wheel events with no phase, and silence is the only sign of
//! a lift — the same silence as fingers resting on the pad. The shell can:
//! macOS reports `NSEvent.phase` (Began / Changed / Ended / Cancelled) and
//! `momentumPhase` on every scroll event, and GTK reports two-finger motion
//! as a smooth-scroll stream closed by a stop event at lift-off. This module
//! claims the horizontal touchpad streams while `@tmuxy-gesture-swipe-tabs`
//! is on, hands each event to the page as `window.tmuxyGesture(...)`, and
//! keeps the events that carry a delta away from the webview, so the page
//! does not also scroll on them.
//!
//! The contract the page's gesture actor consumes, once per claimed event:
//! `window.tmuxyGesture('slide', phase, dx, dy, t)` — `dx`/`dy` in points,
//! positive when the fingers move right or down; `t` the event's own
//! timestamp in seconds.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::WebviewWindow;

/// `@tmuxy-gesture-swipe-tabs`, as the page last reported it. Off, the shell
/// claims nothing and the webview scrolls as it would in a browser.
static SWIPE_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_swipe_tabs(enabled: bool) {
    SWIPE_ENABLED.store(enabled, Ordering::Relaxed);
}

/// How much the horizontal axis has to dominate for a slide to start — the
/// same rule the page applied when it did this itself.
const SWIPE_AXIS_RATIO: f64 = 1.5;

fn horizontal(dx: f64, dy: f64) -> bool {
    dx.abs() >= 1.0 && dx.abs() > dy.abs() * SWIPE_AXIS_RATIO
}

/// The call the page gets for one claimed event.
fn forward(window: &WebviewWindow, phase: &str, dx: f64, dy: f64, t: f64) {
    let _ = window.eval(format!(
        "window.tmuxyGesture?.('slide','{phase}',{dx},{dy},{t})"
    ));
}

/// What one scroll stream is to the shell, from its first step to its end.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    /// Nothing under way.
    Idle,
    /// Begun, no delta seen yet: the first delta decides. (GTK has no begin
    /// event; its first delta is the beginning.)
    #[cfg(target_os = "macos")]
    Pending,
    /// A slide the page is being told about; its deltas are swallowed.
    Claimed,
    /// A stream that is not a slide (vertical, a mouse wheel): left alone to its end.
    Passed,
}

#[cfg(target_os = "macos")]
pub use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use super::{forward, horizontal, Stream, SWIPE_ENABLED};
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::sync::atomic::Ordering;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};
    use tauri::{AppHandle, Manager, WebviewWindow};

    /// The monitor, kept for the life of the app (AppKit holds it weakly).
    pub struct Monitor(#[allow(dead_code)] Retained<AnyObject>);
    // SAFETY: only ever touched from the main thread, through `run_on_main_thread`.
    unsafe impl Send for Monitor {}
    unsafe impl Sync for Monitor {}

    /// The window a scroll event belongs to, by its NSWindow.
    fn window_of(app: &AppHandle, event: &NSEvent, mtm: MainThreadMarker) -> Option<WebviewWindow> {
        let ns_window = event.window(mtm)?;
        let wanted = Retained::as_ptr(&ns_window) as *const std::ffi::c_void;
        app.webview_windows().into_values().find(|w| {
            w.ns_window()
                .map(|p| std::ptr::eq(p.cast_const(), wanted))
                .unwrap_or(false)
        })
    }

    /// Install one app-wide local monitor for scroll-wheel events, the first
    /// time a window asks. It runs before `-[NSApplication sendEvent:]`, so
    /// before the WKWebView, and returning null is what keeps an event from
    /// the webview. A slide's Began / Ended / Cancelled carry no delta and
    /// are let through, so WebKit's own bookkeeping of the gesture opens and
    /// closes as usual; only the steps that would scroll the page, and the
    /// momentum tail after a lift, are kept back.
    pub fn install(window: &WebviewWindow) {
        let app = window.app_handle();
        if app.try_state::<Monitor>().is_some() {
            return;
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let app = handle.clone();
            let stream = Cell::new(Stream::Idle);
            // The momentum tail of a claimed slide is swallowed to its end.
            let tail = Cell::new(false);
            let block = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
                // SAFETY: AppKit hands the monitor a live event for the call.
                let event = unsafe { ev.as_ref() };
                let pass = ev.as_ptr();
                let swallow = std::ptr::null_mut();

                let momentum = event.momentumPhase();
                if !momentum.is_empty() {
                    if !tail.get() {
                        return pass;
                    }
                    if let Some(window) = window_of(&app, event, mtm) {
                        let ended = momentum.contains(NSEventPhase::Ended)
                            || momentum.contains(NSEventPhase::Cancelled);
                        forward(
                            &window,
                            if ended { "momentum-ended" } else { "momentum" },
                            event.scrollingDeltaX(),
                            event.scrollingDeltaY(),
                            event.timestamp(),
                        );
                        if ended {
                            tail.set(false);
                        }
                    }
                    return swallow;
                }

                let phase = event.phase();
                // A mouse wheel has no phase at all.
                if phase.is_empty() {
                    return pass;
                }
                if phase.contains(NSEventPhase::MayBegin) {
                    return pass;
                }
                if phase.contains(NSEventPhase::Began) {
                    tail.set(false);
                    stream.set(Stream::Pending);
                    return pass;
                }
                let dx = event.scrollingDeltaX();
                let dy = event.scrollingDeltaY();
                let t = event.timestamp();
                if phase.contains(NSEventPhase::Changed) {
                    match stream.get() {
                        Stream::Pending => {
                            // The option alone decides, not the Trackpad
                            // preference "Swipe between pages": macOS delivers
                            // the two-finger scroll either way.
                            let claim = event.hasPreciseScrollingDeltas()
                                && SWIPE_ENABLED.load(Ordering::Relaxed)
                                && horizontal(dx, dy);
                            if !claim {
                                stream.set(Stream::Passed);
                                return pass;
                            }
                            let Some(window) = window_of(&app, event, mtm) else {
                                stream.set(Stream::Passed);
                                return pass;
                            };
                            stream.set(Stream::Claimed);
                            forward(&window, "began", 0.0, 0.0, t);
                            forward(&window, "changed", dx, dy, t);
                            swallow
                        }
                        Stream::Claimed => {
                            if let Some(window) = window_of(&app, event, mtm) {
                                forward(&window, "changed", dx, dy, t);
                            }
                            swallow
                        }
                        Stream::Idle | Stream::Passed => pass,
                    }
                } else {
                    // Ended or Cancelled: the fingers are off the pad.
                    let was = stream.replace(Stream::Idle);
                    if was == Stream::Claimed {
                        if let Some(window) = window_of(&app, event, mtm) {
                            let ended = phase.contains(NSEventPhase::Ended);
                            forward(
                                &window,
                                if ended { "ended" } else { "cancelled" },
                                0.0,
                                0.0,
                                t,
                            );
                        }
                        tail.set(true);
                    }
                    pass
                }
            });
            // SAFETY: the block returns the event it was given or null, as the
            // monitor contract asks; the monitor object is kept in managed
            // state so the handler outlives this call.
            let monitor = unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::ScrollWheel,
                    &block,
                )
            };
            // The bin is `tmuxy`, so `module_path!()` would fall outside the
            // trace allowlist and the log filter; the crate's target is spelled.
            if let Some(monitor) = monitor {
                handle.manage(Monitor(monitor));
                tracing::info!(target: "tmuxy_tauri_app::gestures", "trackpad slide monitor installed");
            } else {
                tracing::warn!(target: "tmuxy_tauri_app::gestures", "trackpad slide monitor could not be installed");
            }
        });
    }
}

#[cfg(target_os = "linux")]
pub use linux::install;

#[cfg(target_os = "linux")]
mod linux {
    use super::{forward, horizontal, Stream, SWIPE_ENABLED};
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::Ordering;

    use gtk::prelude::*;
    use tauri::WebviewWindow;

    /// Connect `scroll-event` on the window's webview widget. The handler runs
    /// before WebKit's own, and `Stop` is what keeps a claimed step from it.
    /// GTK reports two-finger motion as a smooth-scroll stream and marks the
    /// lift with a stop event, before any kinetic scrolling — which WebKit
    /// would synthesise itself and now never does for a claimed slide.
    pub fn install(window: &WebviewWindow) {
        {
            let target = window.clone();
            let _ = window.with_webview(move |webview| {
                let stream = Rc::new(Cell::new(Stream::Idle));
                webview.inner().connect_scroll_event(move |_, event| {
                    let touchpad = event
                        .device()
                        .map(|d| d.source() == gdk::InputSource::Touchpad)
                        .unwrap_or(false);
                    if !touchpad || event.direction() != gdk::ScrollDirection::Smooth {
                        return glib::Propagation::Proceed;
                    }
                    let t = f64::from(event.time()) / 1000.0;
                    if event.is_stop() {
                        let was = stream.replace(Stream::Idle);
                        if was == Stream::Claimed {
                            forward(&target, "ended", 0.0, 0.0, t);
                        }
                        return glib::Propagation::Proceed;
                    }
                    // GTK's deltas are the content's direction; the page wants the fingers'.
                    let (sx, sy) = event.delta();
                    let (dx, dy) = (-sx, -sy);
                    match stream.get() {
                        Stream::Idle => {
                            let claim = SWIPE_ENABLED.load(Ordering::Relaxed) && horizontal(dx, dy);
                            if !claim {
                                stream.set(Stream::Passed);
                                return glib::Propagation::Proceed;
                            }
                            stream.set(Stream::Claimed);
                            forward(&target, "began", 0.0, 0.0, t);
                            forward(&target, "changed", dx, dy, t);
                            glib::Propagation::Stop
                        }
                        Stream::Claimed => {
                            forward(&target, "changed", dx, dy, t);
                            glib::Propagation::Stop
                        }
                        Stream::Passed => glib::Propagation::Proceed,
                    }
                });
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::horizontal;

    #[test]
    fn a_slide_is_mostly_sideways_and_at_least_a_point() {
        assert!(horizontal(4.0, 1.0));
        assert!(horizontal(-2.0, 0.0));
        assert!(!horizontal(0.5, 0.0));
        assert!(!horizontal(3.0, 3.0));
        assert!(!horizontal(1.0, 4.0));
    }
}
