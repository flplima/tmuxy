use std::sync::Arc;

use chromiumoxide::cdp::browser_protocol::browser::{
    Bounds, GetWindowForTargetParams, SetContentsSizeParams, SetWindowBoundsParams,
};
use chromiumoxide::cdp::browser_protocol::emulation::SetDeviceMetricsOverrideParams;
use chromiumoxide::cdp::browser_protocol::page::{
    CaptureScreenshotFormat, CaptureScreenshotParams, EventScreencastFrame,
    ScreencastFrameAckParams, StartScreencastFormat, StartScreencastParams, StopScreencastParams,
    Viewport,
};
use futures_util::StreamExt;
use tokio::sync::watch;

use super::{Attachment, Frame, Session, SessionError};

/// How the page is encoded for the pane.
///
/// JPEG rather than PNG: a frame is replaced within a tenth of a second and
/// compression artefacts are invisible, while a PNG of a photographic page is
/// several times the bytes — and these bytes travel through the SAME control
/// mode stream as keystroke echo, so size here is latency there.
/// How long to wait for a closing browser to actually be gone.
const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How long an explicit frame capture may take before the pane gives up on it.
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The narrowest a browser window's contents get (Chromium's own floor).
const MIN_WINDOW_WIDTH: u32 = 500;

pub(super) const FRAME_QUALITY: i64 = 60;
/// A cap on the encoded frame, independent of the viewport.
///
/// The viewport is what the page LAYS OUT against and follows the pane; this is
/// only how many pixels get encoded. A retina pane asking for its full device
/// resolution would multiply the bytes for detail a pane cannot show.
pub(super) const FRAME_MAX_WIDTH: i64 = 1600;
pub(super) const FRAME_MAX_HEIGHT: i64 = 1000;
/// The shortest gap between two published frames: five a second.
///
/// A pane cannot show more, a terminal stream cannot afford more, and this is a
/// picture of a page rather than video. See the pump in `start_frames` for why
/// this is a time budget and not `everyNthFrame`.
const FRAME_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// Send every Nth frame.
///
/// One, which is to say no throttle, and the reason is worth stating because
/// the obvious value is wrong. `everyNthFrame` counts COMPOSITOR frames, not
/// time: a page being scrolled produces hundreds and a still page produces one
/// or two. At 4, the still page's one-or-two are all dropped — so a `:goto` to
/// an ordinary static page left the PREVIOUS page's picture on screen forever,
/// while a page that animated looked perfect. The throttle silently deleted
/// exactly the frames that matter most.
///
/// The budget is kept by the other two knobs instead, which cost bytes rather
/// than correctness: quality, and the encoded-size cap. A still page costs
/// nothing either way, because it produces no frames to send.
pub(super) const FRAME_EVERY_NTH: i64 = 1;

/// Viewport bounds. The lower one matters: a pane mid-resize reports 0, and a
/// viewport of 0 makes Chromium stop painting, which looks like a broken
/// feature rather than a bad number.
const MIN_VIEWPORT: u32 = 16;
const MAX_VIEWPORT: u32 = 16384;

impl Session {
    /// Lay the page out for a pane of this many CSS pixels.
    ///
    /// Zero or absurd sizes are refused rather than clamped: a pane mid-resize
    /// momentarily reports 0, and a viewport of 0 makes Chromium stop painting
    /// altogether, which looks exactly like the feature being broken.
    pub async fn set_viewport(
        &mut self,
        width: u32,
        height: u32,
        mobile: bool,
    ) -> Result<(), SessionError> {
        if !(MIN_VIEWPORT..=MAX_VIEWPORT).contains(&width)
            || !(MIN_VIEWPORT..=MAX_VIEWPORT).contains(&height)
        {
            return Err(SessionError::BadViewport { width, height });
        }
        // Nothing to do for the size the page already has. A device-sized
        // page keeps its size when the pane changes: re-applying it resized
        // the window and repainted the page on every step of a drag, which
        // is the flicker a resize used to cause.
        if self.page_size == (width, height) && self.mobile == mobile {
            return Ok(());
        }
        // A window is never narrower than `MIN_WINDOW_WIDTH`, and the
        // screencast encodes the whole window: a page narrower than that (a
        // phone) came out with a blank strip beside it, squeezed into the
        // phone's cells. Drawn at a larger scale, it fills the window exactly.
        let view_scale = (f64::from(MIN_WINDOW_WIDTH) / f64::from(width)).max(1.0);
        let mut metrics = SetDeviceMetricsOverrideParams::builder()
            .width(i64::from(width))
            .height(i64::from(height))
            .device_scale_factor(1.0)
            .mobile(mobile);
        // Only when it scales anything: an explicit `scale: 1` left some
        // Chromium builds with a screenshot that never answered.
        if view_scale > 1.0 {
            metrics = metrics.scale(view_scale);
        }
        let metrics = metrics.build().map_err(SessionError::Engine)?;
        self.page
            .execute(metrics)
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        self.view_scale = view_scale;
        self.page_size = (width, height);
        self.mobile = mobile;
        let (width, height) = (
            (f64::from(width) * view_scale).ceil() as u32,
            (f64::from(height) * view_scale).ceil() as u32,
        );
        // The screencast encodes the WINDOW's contents, not the emulated
        // viewport: a pane larger than the headless window's default size got
        // the page laid out for the pane but drawn as the window's top-left
        // corner, stretched over the pane. Our own engine's window contents
        // follow the viewport; an attached browser's window is the user's.
        if self.attachment == Attachment::Launched {
            let window = self
                .page
                .execute(GetWindowForTargetParams::default())
                .await
                .map_err(|e| SessionError::Engine(e.to_string()))?
                .result
                .window_id;
            let contents = SetContentsSizeParams::builder()
                .window_id(window)
                .width(width as i64)
                .height(height as i64)
                .build()
                .map_err(SessionError::Engine)?;
            if self.page.execute(contents).await.is_err() {
                // Browsers before `Browser.setContentsSize` only size the
                // whole window, frame included; the frame then crops a strip
                // off the bottom, which still beats a corner of the page.
                self.page
                    .execute(SetWindowBoundsParams::new(
                        window,
                        Bounds::builder()
                            .width(width as i64)
                            .height(height as i64)
                            .build(),
                    ))
                    .await
                    .map_err(|e| SessionError::Engine(e.to_string()))?;
            }
        }
        if self.screencasting {
            self.publish_current_frame().await;
        }
        Ok(())
    }

    /// Start the screencast and hand back a receiver of encoded frames.
    ///
    /// Two things make a page actually appear, and both were learned the hard
    /// way on the previous transport:
    ///
    /// * Chromium emits a frame only when the page CHANGES visually, so a page
    ///   someone is reading produces none at all. The first frame is therefore
    ///   captured explicitly.
    /// * Every frame must be acknowledged or Chromium stops after a small
    ///   allowance, which looks like the page having frozen rather than the
    ///   stream having stalled.
    pub async fn start_frames(&mut self) -> Result<watch::Receiver<Frame>, SessionError> {
        if self.screencasting {
            return Ok(self.frames.subscribe());
        }

        let mut events = self
            .page
            .event_listener::<EventScreencastFrame>()
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;

        self.page
            .execute(
                StartScreencastParams::builder()
                    .format(StartScreencastFormat::Jpeg)
                    .quality(FRAME_QUALITY)
                    .max_width(FRAME_MAX_WIDTH)
                    .max_height(FRAME_MAX_HEIGHT)
                    .every_nth_frame(FRAME_EVERY_NTH)
                    .build(),
            )
            .await
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        self.screencasting = true;

        let frames = self.frames.clone();
        let page = self.page.clone();
        tokio::spawn(async move {
            // Coalesce by TIME, keeping the newest.
            //
            // A page being scrolled repaints far faster than a pane can show,
            // and every frame is tens of kilobytes of base64 through control
            // mode. Measured before this existed: ~18 frames a second at ~43KB
            // each while scrolling an article, about 580 KB/s down a channel
            // that also carries every keystroke's echo (docs/PERFORMANCE.md).
            //
            // Coalescing rather than dropping is what keeps a STILL page
            // correct: the last frame of a burst is always published once the
            // page settles, so the picture ends up showing where the page
            // actually stopped — which the `everyNthFrame` throttle this
            // replaced could not do, since it threw whole frames away and a
            // still page only ever produces one.
            let mut pending: Option<Frame> = None;
            let mut last_sent = tokio::time::Instant::now() - FRAME_MIN_INTERVAL;
            loop {
                let due = last_sent + FRAME_MIN_INTERVAL;
                tokio::select! {
                    frame = events.next() => {
                        let Some(frame) = frame else { return };
                        // Ack first, before decoding: the sooner Chromium is
                        // free to send the next frame the smoother the stream,
                        // and a frame that fails to decode must not stall every
                        // frame after it.
                        let _ = page
                            .execute(ScreencastFrameAckParams::new(frame.session_id))
                            .await;
                        if let Some(bytes) = base64_decode(frame.data.as_ref()) {
                            if !bytes.is_empty() {
                                pending = Some(Arc::new(bytes));
                            }
                        }
                    }
                    // Nothing new while the budget ran out: whatever is pending
                    // is the current picture, so publish it.
                    _ = tokio::time::sleep_until(due), if pending.is_some() => {
                        if let Some(frame) = pending.take() {
                            // `send_replace`, not `send`: `send` FAILS when
                            // there is no receiver and throws the frame away
                            // with it, and the next drawer is handed the current
                            // value and nothing else.
                            frames.send_replace(frame);
                            last_sent = tokio::time::Instant::now();
                        }
                    }
                }
            }
        });

        // The explicit first frame, for a page that will never change.
        self.publish_current_frame().await;

        Ok(self.frames.subscribe())
    }

    /// Capture the page as it is now and publish it as the current frame.
    ///
    /// For the moments the screencast cannot be relied on to cover: a still
    /// page emits no frame of its own, so the first picture, and the picture
    /// after a resize, are taken explicitly. Without the second, a pane that
    /// changed size kept re-sending the frame of its OLD size, stretched over
    /// the new one — and a click, mapped through the new size, missed.
    async fn publish_current_frame(&mut self) {
        let mut params = CaptureScreenshotParams::builder()
            .format(CaptureScreenshotFormat::Jpeg)
            .quality(FRAME_QUALITY);
        // A page drawn larger than itself (`view_scale`) is captured the way
        // the screencast sees it: the whole page, at the window's scale.
        // Unclipped, the capture came back page-sized with the drawing shrunk
        // into its corner.
        if self.view_scale > 1.0 {
            let (width, height) = self.page_size;
            params = params.clip(Viewport {
                x: 0.0,
                y: 0.0,
                width: f64::from(width),
                height: f64::from(height),
                scale: self.view_scale,
            });
        }
        // Bounded: an engine that paints nothing (a headless build on a
        // locked Mac) never answers a capture, and the pane froze before it
        // read a single key — ctrl+c included. The screencast fills in later.
        let capture = self.page.screenshot(params.build());
        if let Ok(Ok(bytes)) = tokio::time::timeout(CAPTURE_TIMEOUT, capture).await {
            if !bytes.is_empty() {
                self.frames.send_replace(Arc::new(bytes));
            }
        }
    }

    /// End the session.
    ///
    /// An ATTACHED browser is the user's and is left running — closing it would
    /// take their windows with it. A launched one is ours and goes, profile
    /// included: a throwaway profile that is not thrown away is a few hundred MB
    /// per session that nothing will reclaim.
    pub async fn close(&mut self) {
        if self.screencasting {
            let _ = self.page.execute(StopScreencastParams::default()).await;
        }
        if self.attachment == Attachment::Launched {
            let _ = self.browser.close().await;
            // Waited for, not just asked. `close` returns when Chromium has
            // ACCEPTED the request; it then flushes its profile on the way out,
            // and a profile removed before that happens is simply recreated —
            // leaving the throwaway directory on disk, which is the one thing
            // the word "throwaway" promises. Bounded, then killed: a wedged
            // browser must not hold the pane's exit open.
            if tokio::time::timeout(SHUTDOWN_TIMEOUT, self.browser.wait())
                .await
                .is_err()
            {
                let _ = self.browser.kill().await;
                let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, self.browser.wait()).await;
            }
            if let Some(profile) = &self.profile {
                if let Err(error) = std::fs::remove_dir_all(profile) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(
                            target: "tmuxy_server::browser",
                            profile = %profile.display(),
                            %error,
                            "could not remove the session profile"
                        );
                    }
                }
            }
        }
    }
}

/// Decode standard base64 without taking a dependency for one call site.
pub(super) fn base64_decode(encoded: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}
