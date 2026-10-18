use super::*;

// ===========================================================================
// The screencast: a picture of the page, for the pane
// ===========================================================================

/// A session nobody has navigated still produces a frame.
///
/// This is the case that broke twice while building it, both times silently.
/// Chromium emits a screencast frame only when the page CHANGES visually, so a
/// page someone has opened to READ produces nothing at all — and a `watch`
/// channel's `send` throws the value away when no receiver is attached yet, so
/// even the explicit first frame went missing. Either bug alone leaves a blank
/// pane and no error anywhere.
#[tokio::test]
async fn a_still_page_still_produces_a_frame() {
    let state = scratch_dir("screencast-still");
    let Some(mut session) = session_or_skip("a_still_page_still_produces_a_frame", &state).await
    else {
        return;
    };

    // Deliberately NOT navigated: `about:blank` is as static as a page gets.
    let mut frames = session.start_frames().await.expect("start_frames");
    let frame = frames.borrow_and_update().clone();

    assert!(
        !frame.is_empty(),
        "a subscriber must be handed the current frame, not an empty one — a page \
         that never changes produces no screencast event, so the first frame has \
         to be captured explicitly AND retained for whoever connects next"
    );
    assert_eq!(
        &frame[..3],
        b"\xff\xd8\xff",
        "the frame must be a JPEG (SOI marker), not an empty or mis-decoded buffer"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A page that changes keeps producing frames, which is the acknowledgement
/// working: Chromium sends up to a small number of unacknowledged frames and
/// then stops, so a pump that published without acking would show the first few
/// and then a still picture — looking like the page had stopped, not the stream.
#[tokio::test]
async fn a_changing_page_keeps_producing_frames() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("screencast-moving");
    let Some(mut session) = session_or_skip("a_changing_page_keeps_producing_frames", &state).await
    else {
        return;
    };

    let mut frames = session.start_frames().await.expect("start_frames");
    session
        .run(Verb::Goto {
            url: format!(
                "data:text/html,{}",
                urlencode(
                    "<body><h1 id=n>0</h1><script>let n=0;\
                     setInterval(()=>{n++;document.getElementById('n').textContent=n;\
                     document.body.style.background=n%2?'#123':'#321'},120)</script></body>"
                )
            ),
        })
        .await
        .expect("goto");

    // Count distinct frames rather than events: an implementation that stopped
    // after its unacknowledged allowance would deliver a handful and stall.
    // Each wait runs to the overall deadline: the first frame waits for the
    // browser to start and the page to load, which a slow runner can stretch
    // well past the interval between frames.
    let mut seen = 0;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while seen < 8 {
        if tokio::time::timeout_at(deadline, frames.changed())
            .await
            .is_err()
        {
            break;
        }
        if !frames.borrow_and_update().is_empty() {
            seen += 1;
        }
    }

    assert!(
        seen >= 8,
        "only {seen} frames arrived; Chromium stops sending once its unacknowledged \
         allowance is used up, so this is what a missing Page.screencastFrameAck \
         looks like"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// The viewport is what the PAGE lays out against, so the pane's size has to
/// reach it — and a nonsense size has to be refused rather than clamped: a pane
/// mid-resize reports 0, and a viewport of 0 makes Chromium stop painting
/// altogether, which is indistinguishable from the feature being broken.
#[tokio::test]
async fn the_viewport_follows_the_pane_and_refuses_nonsense() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("viewport");
    let Some(mut session) =
        session_or_skip("the_viewport_follows_the_pane_and_refuses_nonsense", &state).await
    else {
        return;
    };

    session
        .set_viewport(480, 800, false)
        .await
        .expect("set_viewport");
    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "innerWidth + 'x' + innerHeight".to_string()
            })
            .await
            .expect("read the viewport"),
        Output::Line("480x800".to_string()),
        "the page must lay out at the size it was given"
    );

    for (w, h) in [(0, 800), (480, 0), (99_999, 800)] {
        assert!(
            session.set_viewport(w, h, false).await.is_err(),
            "{w}x{h} must be refused, not clamped"
        );
    }
    // And the refusal left the usable one in place.
    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "innerWidth".to_string()
            })
            .await
            .expect("viewport survived"),
        Output::Line("480".to_string())
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A click and a key forwarded from a pane reach the page.
///
/// Through `pane`'s own forwarding rather than a CDP call of the test's own,
/// because the mapping is the part that can be wrong: a mouse report arrives in
/// CELLS, and the page needs CSS pixels. An off-by-one-cell click lands next to
/// the link the user aimed at, and nothing but a real page can tell you that.
#[tokio::test]
async fn a_click_and_a_key_from_a_pane_reach_the_page() {
    use tmuxy_server::browser::pane::{self, PaneSize};
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;
    use tmuxy_server::browser::verbs::Viewport;

    let state = scratch_dir("input");
    let Some(mut session) =
        session_or_skip("a_click_and_a_key_from_a_pane_reach_the_page", &state).await
    else {
        return;
    };

    // A pane whose cells are a known size, so the test can name a cell and say
    // which pixel it must become.
    let size = PaneSize {
        cols: 100,
        rows: 51,
        cell_w: 8,
        cell_h: 16,
    };
    let page = pane::layout(size, Viewport::Auto);
    let (vw, vh) = (page.page_w, page.page_h);
    session
        .set_viewport(vw, vh, false)
        .await
        .expect("the viewport the pane implies");

    session
        .run(Verb::Goto {
            url: format!(
                "data:text/html,{}",
                urlencode(
                    "<body style='margin:0'>\
                     <div id=hit style='position:absolute;left:0;top:0;width:400px;height:200px'></div>\
                     <p id=out style='position:absolute;top:300px'>none</p>\
                     <script>document.getElementById('hit')\
                     .addEventListener('click',()=>{document.getElementById('out').textContent='hit'});\
                     document.addEventListener('keydown',e=>{\
                     document.getElementById('out').textContent='key:'+e.key})</script></body>"
                )
            ),
        })
        .await
        .expect("goto");

    // Cell (10, 5) is inside the 400x200 box at pixel (76, 72); a mapping that
    // used the cell's corner, or forgot to make the coordinates zero-based,
    // still lands in it — so the box is deliberately small enough that being a
    // few cells out does not.
    for pressed in [true, false] {
        pane::forward_mouse(&mut session, page, 0, 10, 5, pressed).await;
    }
    for _ in 0..40 {
        if session
            .run(Verb::Text {
                selector: Some("#out".to_string()),
            })
            .await
            .ok()
            == Some(Output::Text("hit".to_string()))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("read the click's effect"),
        Output::Text("hit".to_string()),
        "a press and release at a pane cell must land as a click inside the box there"
    );

    // A key, likewise — and `q` rather than an arrow because a printable key is
    // the one that must carry `text`.
    pane::forward_key(&mut session, b"q").await;
    for _ in 0..40 {
        if session
            .run(Verb::Text {
                selector: Some("#out".to_string()),
            })
            .await
            .ok()
            == Some(Output::Text("key:q".to_string()))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("read the key's effect"),
        Output::Text("key:q".to_string())
    );

    // The status row belongs to tmuxy, not the page: a report on it is dropped
    // rather than forwarded to a coordinate off the bottom of the viewport.
    pane::forward_mouse(&mut session, page, 0, 10, size.rows, true).await;
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("the page is unchanged"),
        Output::Text("key:q".to_string()),
        "a click on the status row must not reach the page"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// Navigating a STILL page produces a new frame.
///
/// The gap the existing frame tests left: one covers a page that animates, the
/// other a page that never changes at all. In between is what a browser pane
/// actually does — sit on a static page, navigate, and sit on another static
/// page — and a pane that keeps drawing the FIRST page's picture after a
/// `:goto` looks exactly like a broken renderer.
#[tokio::test]
async fn navigating_a_still_page_produces_a_new_frame() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("screencast-navigate");
    let Some(mut session) =
        session_or_skip("navigating_a_still_page_produces_a_new_frame", &state).await
    else {
        return;
    };

    let mut frames = session.start_frames().await.expect("start_frames");
    // The explicit first capture is bounded (CAPTURE_TIMEOUT), and when a slow
    // runner's engine misses it the screencast supplies the picture instead —
    // so the first frame is waited for, up to its own deadline, not assumed.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while frames.borrow().is_empty() {
        if tokio::time::timeout_at(deadline, frames.changed())
            .await
            .is_err()
        {
            break;
        }
    }
    let first = frames.borrow_and_update().clone();
    assert!(!first.is_empty(), "the first frame");

    session
        .run(Verb::Goto {
            url: format!(
                "data:text/html,{}",
                urlencode("<body style='background:#c0ffee'><h1>AFTER</h1></body>")
            ),
        })
        .await
        .expect("goto");

    // One deadline for the whole wait: a slow runner may take a while to
    // paint the new page, and that is not the same as never painting it.
    let mut latest = first.clone();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while latest == first {
        if tokio::time::timeout_at(deadline, frames.changed())
            .await
            .is_err()
        {
            break;
        }
        latest = frames.borrow_and_update().clone();
    }

    assert_ne!(
        latest, first,
        "the picture must follow the page: after a navigation the pane is still \
         drawing the page it left"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}
