//! Driving a real browser.
//!
//! The configuration is unit-tested without one: the flags, the profile paths,
//! the verb grammar, the cell-to-pixel mapping. None of that proves a page can
//! be driven, and the parts that can only be wrong in the real thing are the
//! ones a user notices — that a framework sees the text `type` entered, that a
//! still page produces a frame at all, that a click forwarded from a pane cell
//! lands where the user pointed.
//!
//! So this launches the engine `tmuxy browser` launches and asks it real
//! questions. It SKIPS when there is no browser on the machine rather than
//! failing: the feature is explicitly "the user's own engine, or no feature",
//! and a CI job without one should not go red over a browser nobody installed.
//! The skip is loud (`eprintln!` + the reason), because a silent skip is how a
//! suite reports green for tests that never ran.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(unix)]

use std::path::{Path, PathBuf};
use tmuxy_server::browser::{discover, engine, session::Session};

/// A scratch state dir of this test's own, cleaned up after.
fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-engine-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// The browser to drive, or None with the reason printed.
fn browser_or_skip(test: &str) -> Option<PathBuf> {
    match discover::find_browser() {
        Ok(path) => Some(path),
        Err(why) => {
            eprintln!("SKIP {test}: {why}");
            None
        }
    }
}

/// The profile lock is the one failure that outlives a session: a half-dead
/// engine holding it means the NEXT session with that name cannot start. So
/// closing and relaunching on the same name has to work.
///
/// The only engine-level test left. Everything else the engine does is reached
/// through a verb, and a test that goes round the verbs to assert on CDP would
/// be asserting on chromiumoxide rather than on tmuxy.
#[tokio::test]
async fn a_profile_is_reusable_after_a_clean_close() {
    let state = scratch_dir("relaunch");
    if browser_or_skip("a_profile_is_reusable_after_a_clean_close").is_none() {
        return;
    }

    for attempt in ["first", "second"] {
        let mut session = Session::launch(&state, "relaunch")
            .await
            .unwrap_or_else(|why| panic!("the {attempt} launch must work: {why}"));
        session
            .run(tmuxy_server::browser::verbs::Verb::Url)
            .await
            .unwrap_or_else(|why| panic!("the {attempt} engine must answer: {why}"));
        session.close().await;
        // The profile is removed with the session, so the second launch also
        // proves `close` left nothing behind that blocks a fresh one.
        assert!(
            !engine::profile_dir(&state, "relaunch").exists(),
            "closing a launched session must take its throwaway profile with it"
        );
    }

    let _ = std::fs::remove_dir_all(&state);
}

// ===========================================================================
// The session layer: verbs against a real page
// ===========================================================================
//
// `Engine` carries CDP; `Session` is the verbs built on it, and those are what
// a user and an agent actually invoke. The interesting ones cannot be
// unit-tested, because what they assert is how a real page reacts: that a
// framework sees the text `type` entered, that `click` works on an element
// nothing has scrolled into view, that `wait` returns when an element appears
// rather than when a timer expires.

/// A page with the shapes the verbs are about, as a `data:` URL — so the test
/// needs no listening socket to prove something about a browser.
fn fixture_page() -> String {
    let html = "\
<title>Verb Fixture</title>\
<h1>Heading</h1>\
<input id=\"field\">\
<button id=\"go\" onclick=\"document.querySelector('#out').textContent='clicked'\">Go</button>\
<p id=\"out\"></p>\
<p id=\"hidden\" style=\"display:none\">invisible</p>\
<script>\
document.querySelector('#field').addEventListener('input', e => {\
  document.querySelector('#out').dataset.sawInput = e.target.value;\
});\
setTimeout(() => {\
  const late = document.createElement('div');\
  late.id = 'late';\
  late.textContent = 'arrived';\
  document.body.appendChild(late);\
}, 700);\
</script>";
    format!("data:text/html,{}", urlencode(html))
}

/// Percent-encode what a `data:` URL cannot carry literally.
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'!'
            | b'*'
            | b'\''
            | b'('
            | b')'
            | b';'
            | b':'
            | b'@'
            | b'='
            | b'+'
            | b'$'
            | b','
            | b'/'
            | b'?'
            | b'['
            | b']'
            | b'<'
            | b'>'
            | b'{'
            | b'}'
            | b'|'
            | b'^'
            | b'`' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Start a session on a scratch state dir, or skip.
async fn session_or_skip(
    test: &str,
    state: &Path,
) -> Option<tmuxy_server::browser::session::Session> {
    if browser_or_skip(test).is_none() {
        return None;
    }
    match Session::launch(state, "verbs").await {
        Ok(session) => Some(session),
        Err(why) => panic!("{test}: could not start a session: {why}"),
    }
}

/// Every verb that reads something, against one page.
///
/// One test rather than six, because they share a page load and the load is
/// most of the cost — and because "one feature, one test" (docs/TESTS.md) is
/// about a feature, which here is the verb vocabulary.
#[tokio::test]
async fn the_reading_verbs_answer_from_a_real_page() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-read");
    let Some(mut session) =
        session_or_skip("the_reading_verbs_answer_from_a_real_page", &state).await
    else {
        return;
    };

    let landed = session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");
    assert!(
        matches!(&landed, Output::Line(url) if url.starts_with("data:text/html,")),
        "goto echoes where it landed, got {landed:?}"
    );

    assert_eq!(
        session.run(Verb::Title).await.expect("title"),
        Output::Line("Verb Fixture".to_string())
    );

    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("h1".to_string())
            })
            .await
            .expect("text h1"),
        Output::Text("Heading".to_string())
    );

    // innerText, not textContent: a hidden element says nothing, and the
    // `<script>` body must not appear in the page's text either.
    let body = session
        .run(Verb::Text { selector: None })
        .await
        .expect("text");
    let body = body.to_string();
    assert!(
        body.contains("Heading"),
        "the visible text is there: {body:?}"
    );
    assert!(
        !body.contains("invisible"),
        "a display:none element is not visible text: {body:?}"
    );
    assert!(
        !body.contains("addEventListener"),
        "a script body is not page text: {body:?}"
    );

    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "6 * 7".to_string()
            })
            .await
            .expect("eval"),
        Output::Line("42".to_string())
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// The verbs that change the page. `type` is the one with a trap: setting
/// `.value` alone is invisible to anything tracking state from events, so the
/// fixture records what its `input` listener actually saw.
#[tokio::test]
async fn the_acting_verbs_change_a_real_page() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-act");
    let Some(mut session) = session_or_skip("the_acting_verbs_change_a_real_page", &state).await
    else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    session
        .run(Verb::Type {
            selector: "#field".to_string(),
            text: "hello there".to_string(),
        })
        .await
        .expect("type");

    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "document.querySelector('#field').value".to_string()
            })
            .await
            .expect("read the field"),
        Output::Line("hello there".to_string()),
        "the field holds the text"
    );
    assert_eq!(
        session
            .run(Verb::Eval {
                expression: "document.querySelector('#out').dataset.sawInput".to_string()
            })
            .await
            .expect("read the listener's record"),
        Output::Line("hello there".to_string()),
        "a framework listening for `input` must have seen it — assigning .value \
         alone leaves the app unaware of text the user can see"
    );

    session
        .run(Verb::Click {
            selector: "#go".to_string(),
        })
        .await
        .expect("click");
    assert_eq!(
        session
            .run(Verb::Text {
                selector: Some("#out".to_string())
            })
            .await
            .expect("read the click's effect"),
        Output::Text("clicked".to_string())
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// `wait` must return when the element appears, not when a timer expires. The
/// fixture adds `#late` after 700ms, so a `wait` that returned immediately or
/// only after its full 20s budget would both be wrong.
#[tokio::test]
async fn wait_returns_when_the_element_arrives() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-wait");
    let Some(mut session) = session_or_skip("wait_returns_when_the_element_arrives", &state).await
    else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    // Not there yet when the page has just settled.
    let started = std::time::Instant::now();
    session
        .run(Verb::Wait {
            selector: "#late".to_string(),
        })
        .await
        .expect("wait");
    let waited = started.elapsed();

    assert!(
        waited < std::time::Duration::from_secs(15),
        "wait should return when the element arrives, not at its budget: {waited:?}"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A selector that matches nothing is a named error, not a silent success. An
/// agent that cannot tell "clicked" from "there was nothing to click" will act
/// on the wrong belief.
#[tokio::test]
async fn a_verb_on_a_missing_element_says_so() {
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-missing");
    let Some(mut session) = session_or_skip("a_verb_on_a_missing_element_says_so", &state).await
    else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    let error = session
        .run(Verb::Click {
            selector: "#nothing-like-this".to_string(),
        })
        .await
        .expect_err("clicking nothing must fail");
    assert!(
        error.to_string().contains("#nothing-like-this"),
        "the error names the selector: {error}"
    );

    // And a page that throws reports what it threw, not a transport failure.
    let thrown = session
        .run(Verb::Eval {
            expression: "definitelyNotDefined()".to_string(),
        })
        .await
        .expect_err("a throwing expression must fail");
    assert!(
        thrown.to_string().contains("definitelyNotDefined"),
        "the page's own error survives: {thrown}"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

/// A screenshot is a real PNG on disk. Checked by its magic bytes rather than
/// its size: a zero-byte file and a base64 decode that silently produced
/// garbage would both pass a "the file exists" assertion.
#[tokio::test]
async fn a_screenshot_is_a_png_on_disk() {
    use tmuxy_server::browser::session::Output;
    use tmuxy_server::browser::verbs::Verb;

    let state = scratch_dir("verbs-shot");
    let Some(mut session) = session_or_skip("a_screenshot_is_a_png_on_disk", &state).await else {
        return;
    };
    session
        .run(Verb::Goto {
            url: fixture_page(),
        })
        .await
        .expect("goto");

    let target = state.join("shot.png");
    let printed = session
        .run(Verb::Shot {
            path: Some(target.display().to_string()),
        })
        .await
        .expect("shot");
    assert_eq!(printed, Output::Line(target.display().to_string()));

    let bytes = std::fs::read(&target).expect("the screenshot exists");
    assert_eq!(
        &bytes[..8],
        b"\x89PNG\r\n\x1a\n",
        "the file must be a real PNG, not an empty or mis-decoded one"
    );

    session.close().await;
    let _ = std::fs::remove_dir_all(&state);
}

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
        .set_viewport(480, 800, 1.0)
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
            session.set_viewport(w, h, 1.0).await.is_err(),
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
    let (vw, vh) = size.viewport();
    session
        .set_viewport(vw, vh, 1.0)
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
        pane::forward_mouse(&mut session, size, 0, 10, 5, pressed).await;
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
    pane::forward_mouse(&mut session, size, 0, 10, size.rows, true).await;
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
    let first = frames.borrow_and_update().clone();
    assert!(!first.is_empty(), "the explicit first frame");

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
