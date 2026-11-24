//! What the core asks tmux for at attach and when the client's size changes,
//! counted against a tmux that answers in order: each pane captured once,
//! each window resized once, no list sent twice for one change. On the
//! in-browser guest every one of these round trips costs tmux a fifth of a
//! second or more.

use super::tests::{core, response, sent, Core};
use super::*;
use crate::constants::tmux_formats::{PaneColumn, RowBuilder, TmuxList, WindowColumn};
use crate::control_mode::state::{
    Markers, CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER, LIST_BEGIN_MARKER, LIST_END_MARKER,
    REPLY_BEGIN_MARKER, REPLY_END_MARKER, VERSION_MARKER,
};
use std::collections::{BTreeMap, VecDeque};

/// The demo's session under `pane-border-status top`: tab @0 holds %0 and %1
/// side by side, tab @1 holds %2 over %4, beside %3.
fn cells(window: u32, (w, h): (u32, u32)) -> Vec<(u32, u32, u32, u32, u32)> {
    let left = w / 2;
    let right = w - left - 1;
    if window == 0 {
        return vec![(0, 0, 0, left, h), (1, left + 1, 0, right, h)];
    }
    let top = h / 2;
    let bottom = h - top - 1;
    vec![
        (2, 0, 0, left, top),
        (4, 0, top + 1, left, bottom),
        (3, left + 1, 0, right, h),
    ]
}

/// The `%layout-change` tmux sends for `window` at `size`: layout cells.
fn layout_change(window: u32, size: (u32, u32)) -> ControlModeEvent {
    let (w, h) = size;
    let leaf =
        |(pane, x, y, cw, ch): (u32, u32, u32, u32, u32)| format!("{cw}x{ch},{x},{y},{pane}");
    let c = cells(window, size);
    let body = if window == 0 {
        format!("{w}x{h},0,0{{{},{}}}", leaf(c[0]), leaf(c[1]))
    } else {
        let (left, column) = (c[0].3, h);
        format!(
            "{w}x{h},0,0{{{left}x{column},0,0[{},{}],{}}}",
            leaf(c[0]),
            leaf(c[1]),
            leaf(c[2])
        )
    };
    let layout = format!("{:04x},{body}", crate::layout::checksum(&body));
    ControlModeEvent::LayoutChange {
        window_id: WindowId::from_number(window),
        layout: layout.clone(),
        visible_layout: layout,
        flags: "*".to_string(),
    }
}

/// A tmux that runs the core's lines one at a time, in order, answering each
/// read as `list-panes` and `capture-pane` would and announcing each resize
/// with its `%layout-change` before the next line runs.
struct Tmux {
    markers: Markers,
    sizes: [(u32, u32); 2],
}

impl Tmux {
    fn mark(&self, marker: &str, argument: &str) -> ControlModeEvent {
        response(format!("{} {argument}", self.markers.tag(marker)).trim_end())
    }

    fn list(&self, list: TmuxList, rows: String) -> Vec<ControlModeEvent> {
        vec![
            self.mark(LIST_BEGIN_MARKER, list.name()),
            response(&rows),
            self.mark(LIST_END_MARKER, ""),
        ]
    }

    /// tmux's panes: a cell on the top edge gives its top row to the border.
    fn pane_rows(&self) -> String {
        let mut rows = Vec::new();
        for window in 0..2u32 {
            for (pane, x, y, w, h) in cells(window, self.sizes[window as usize]) {
                let (y, h) = if y == 0 { (1, h - 1) } else { (y, h) };
                let row = RowBuilder::<PaneColumn>::new()
                    .set(PaneColumn::PaneId, format!("%{pane}"))
                    .set(PaneColumn::PaneIndex, pane)
                    .set(PaneColumn::Left, x)
                    .set(PaneColumn::Top, y)
                    .set(PaneColumn::Width, w)
                    .set(PaneColumn::Height, h)
                    .set(PaneColumn::Active, u8::from(pane == 0 || pane == 2))
                    .set(PaneColumn::Command, "bash")
                    .set(PaneColumn::Mode, 0)
                    .set(PaneColumn::WindowId, format!("@{window}"));
                rows.push(row.build());
            }
        }
        rows.join("\n")
    }

    fn window_rows(&self) -> String {
        (0..2u32)
            .map(|window| {
                RowBuilder::<WindowColumn>::new()
                    .set(WindowColumn::WindowId, format!("@{window}"))
                    .set(WindowColumn::Index, window + 1)
                    .set(WindowColumn::Active, u8::from(window == 0))
                    .set(WindowColumn::Zoomed, 0)
                    .set(WindowColumn::Name, "tmuxy")
                    .build()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn resize(&mut self, line: &str) -> Vec<ControlModeEvent> {
        let words: Vec<&str> = line.split_whitespace().collect();
        let value = |flag: &str| {
            let at = words.iter().position(|w| *w == flag).expect("a size");
            words[at + 1].parse::<u32>().expect("a number")
        };
        // Untargeted, or by the session's name: the current window, @0.
        let window = words
            .iter()
            .find_map(|w| w.strip_prefix('@'))
            .map_or(0, |n| n.parse().expect("a window id"));
        self.sizes[window as usize] = (value("-x"), value("-y"));
        vec![layout_change(window, self.sizes[window as usize])]
    }

    /// What tmux sends back for `line`; unmarked acks change nothing and
    /// are left out.
    fn run(&mut self, line: &str) -> Vec<ControlModeEvent> {
        let reply = |marker: &str| {
            line.strip_prefix(&format!(
                "display-message -p '{} ",
                self.markers.tag(marker)
            ))
            .and_then(|rest| rest.strip_suffix('\''))
            .map(str::to_string)
        };
        if line == self.markers.list_command(TmuxList::Panes) {
            return self.list(TmuxList::Panes, self.pane_rows());
        }
        if line == self.markers.list_command(TmuxList::Windows) {
            return self.list(TmuxList::Windows, self.window_rows());
        }
        if line == self.markers.list_command(TmuxList::Stash) {
            return self.list(TmuxList::Stash, String::new());
        }
        if let Some(pane) = captured_pane(line) {
            return vec![
                self.mark(CAPTURE_BEGIN_MARKER, &format!("{pane} 0 0")),
                response("$ "),
                self.mark(CAPTURE_END_MARKER, ""),
            ];
        }
        if line.starts_with("resizew") {
            return self.resize(line);
        }
        if line == self.markers.version_read_command() {
            return vec![self.mark(VERSION_MARKER, "3.7c")];
        }
        for marker in [REPLY_BEGIN_MARKER, REPLY_END_MARKER] {
            if let Some(id) = reply(marker) {
                return vec![self.mark(marker, &id)];
            }
        }
        Vec::new()
    }
}

fn captured_pane(line: &str) -> Option<u32> {
    let (_, rest) = line.split_once("capture-pane -t %")?;
    rest.split(' ').next()?.parse().ok()
}

/// The guest's core over [`Tmux`]: every line it sends is queued, and tmux
/// runs the queue in order while the core answers each event at once.
struct Guest {
    core: Core,
    tmux: Tmux,
    now: Instant,
    queue: VecDeque<String>,
    log: Vec<String>,
}

impl Guest {
    /// Attached at `size` over a session whose windows are `sizes`, the
    /// client's viewport set to `size` at once, as the page does.
    fn attach(size: (u32, u32), sizes: [(u32, u32); 2]) -> Self {
        let (core, now) = core("demo");
        let mut core = core.with_read_pacing(ReadPacing::OneBatchInFlight);
        let markers = core.aggregator().markers().clone();
        let lines = core.attach_commands(size, AttachConfig::default(), now);
        let mut guest = Guest {
            core,
            tmux: Tmux { markers, sizes },
            now,
            queue: VecDeque::new(),
            log: Vec::new(),
        };
        guest.send(lines);
        let sized = guest.core.set_client_size(size.0, size.1);
        guest.send(sent(&sized).into_iter().map(String::from).collect());
        guest.step(ControlModeEvent::SessionChanged {
            session_id: "$0".to_string(),
            session_name: "demo".to_string(),
        });
        guest
    }

    fn send(&mut self, lines: Vec<String>) {
        self.log.extend(lines.iter().cloned());
        self.queue.extend(lines);
    }

    fn step(&mut self, event: ControlModeEvent) {
        let actions = self.core.step(event, self.now);
        self.send(sent(&actions).into_iter().map(String::from).collect());
    }

    /// tmux runs everything queued, and what the core sends meanwhile.
    fn settle(&mut self) {
        while let Some(line) = self.queue.pop_front() {
            for event in self.tmux.run(&line) {
                self.step(event);
            }
        }
    }

    fn tick(&mut self, after: Duration) {
        let due = self.core.tick(self.now + after);
        self.send(sent(&due).into_iter().map(String::from).collect());
    }

    fn resize_client(&mut self, size: (u32, u32)) {
        let resized = self.core.set_client_size(size.0, size.1);
        self.send(sent(&resized).into_iter().map(String::from).collect());
        let relist = self.core.resync(self.now);
        self.send(relist);
    }

    /// Captures sent since `from`, by pane.
    fn captures(&self, from: usize) -> BTreeMap<u32, usize> {
        let mut counts = BTreeMap::new();
        for pane in self.log[from..].iter().filter_map(|l| captured_pane(l)) {
            *counts.entry(pane).or_insert(0) += 1;
        }
        counts
    }

    fn sent_since(&self, from: usize, pick: impl Fn(&str) -> bool) -> Vec<&str> {
        self.log[from..]
            .iter()
            .map(String::as_str)
            .filter(|l| pick(l))
            .collect()
    }

    fn pane_lists_since(&self, from: usize) -> usize {
        let panes = self.tmux.markers.list_command(TmuxList::Panes);
        self.sent_since(from, |l| l == panes).len()
    }
}

fn once_each(panes: &[u32]) -> BTreeMap<u32, usize> {
    panes.iter().map(|pane| (*pane, 1)).collect()
}

/// The attach's own `resizew` is announced before its lists are answered,
/// and the client's size, the attach's, asked one more: the tab in front was
/// captured in a batch of its own and again after the lists, and the first
/// state waited for the second round. Now the attach's lists are the first
/// batch, and every capture asked meanwhile goes in the one after it.
#[test]
fn an_attach_captures_each_pane_once_when_nothing_resizes_it() {
    let mut guest = Guest::attach((80, 30), [(80, 30); 2]);
    guest.settle();
    assert!(guest.core.aggregator().initial_state_ready());
    assert_eq!(
        guest.captures(0),
        once_each(&[0, 1, 2, 3, 4]),
        "{:#?}",
        guest.log
    );
    assert_eq!(
        guest.sent_since(0, |l| l.starts_with("resizew")),
        ["resizew -t 'demo' -x 80 -y 30"],
        "the client's size is the attach's: the current window is sized once"
    );
    assert_eq!(guest.pane_lists_since(0), 2, "{:#?}", guest.log);

    // The page's `get_initial_state` right after: nothing is resized, and
    // nothing is captured again.
    let mark = guest.log.len();
    guest.resize_client((80, 30));
    guest.settle();
    assert!(guest.captures(mark).is_empty(), "{:#?}", &guest.log[mark..]);
}

/// The page resizes the client and re-syncs at once. The re-sync's lists
/// stand in for the ones a batch already out would have sent next, a list
/// tmux answered from before the resize does not ask the windows again, and
/// each resized pane is captured once, after tmux has resized it.
#[test]
fn a_client_resize_resizes_each_window_once_and_captures_each_pane_once() {
    let mut guest = Guest::attach((80, 30), [(80, 30); 2]);
    guest.settle();
    let mark = guest.log.len();
    // A title changed: a list goes out, and is still out when the size does.
    guest.step(ControlModeEvent::SubscriptionChanged {
        name: crate::constants::tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME.to_string(),
        pane_id: "%0".parse().unwrap(),
    });
    assert_eq!(guest.pane_lists_since(mark), 1);
    guest.resize_client((150, 40));
    guest.settle();
    guest.tick(METADATA_SYNC_DELAY);
    guest.settle();

    let mut resizes = guest.sent_since(mark, |l| l.starts_with("resizew"));
    resizes.sort_unstable();
    assert_eq!(
        resizes,
        ["resizew -t @0 -x 150 -y 40", "resizew -t @1 -x 150 -y 40"]
    );
    assert_eq!(guest.captures(mark), once_each(&[0, 1, 2, 3, 4]));
    // The title's list, the re-sync's, and the one ahead of the captures.
    assert_eq!(guest.pane_lists_since(mark), 3, "{:#?}", &guest.log[mark..]);
    let state = guest.core.aggregator_mut().to_tmux_state();
    let pane = |id: &str| state.panes.iter().find(|p| p.tmux_id == id).expect(id);
    assert_eq!((pane("%0").y, pane("%0").height), (1, 39));
    assert_eq!((pane("%4").y, pane("%4").height), (21, 19));
}

/// Attached at the client's size from the start, the window behind the
/// current one is resized once, and every pane captured once at its final
/// size: the panes of the window behind, listed at its old size and resized
/// while their captures still waited to go out, are not captured twice.
#[test]
fn attaching_at_the_clients_size_captures_each_pane_once() {
    let mut guest = Guest::attach((150, 40), [(80, 30); 2]);
    guest.settle();
    assert!(guest.core.aggregator().initial_state_ready());
    assert_eq!(
        guest.captures(0),
        once_each(&[0, 1, 2, 3, 4]),
        "{:#?}",
        guest.log
    );
    assert_eq!(
        guest.sent_since(0, |l| l.starts_with("resizew")),
        [
            "resizew -t 'demo' -x 150 -y 40",
            "resizew -t @1 -x 150 -y 40"
        ],
        "{:#?}",
        guest.log
    );
    let state = guest.core.aggregator_mut().to_tmux_state();
    assert!(state
        .panes
        .iter()
        .filter(|p| p.y == 1)
        .all(|p| p.height == 39 || p.height == 19));
}

/// A capture that lands is tmux's answer to the core's own read, in a batch
/// whose `list-panes` has just read every pane's metadata: no re-list of
/// everything half a second later.
#[test]
fn a_landed_capture_does_not_relist_everything_after_it() {
    let (mut core, now) = core("app");
    super::tests::with_a_pane(&mut core, now);
    let quiet = core.tick(now + METADATA_SYNC_DELAY);
    assert!(sent(&quiet).is_empty(), "{quiet:?}");
    let markers = core.aggregator().markers().clone();
    let mark = |marker: &str, argument: &str| {
        response(format!("{} {argument}", markers.tag(marker)).trim_end())
    };
    let later = now + Duration::from_secs(1);
    let refresh = core.step(
        ControlModeEvent::PaneModeChanged {
            pane_id: "%0".parse().unwrap(),
        },
        later,
    );
    assert!(sent(&refresh)
        .iter()
        .any(|l| l.contains("capture-pane -t %0 ")));
    for event in [
        mark(CAPTURE_BEGIN_MARKER, "0 0 0"),
        response("$ ls"),
        mark(CAPTURE_END_MARKER, ""),
    ] {
        core.step(event, later);
    }
    let after = core.tick(later + METADATA_SYNC_DELAY);
    assert!(sent(&after).is_empty(), "{after:?}");
}
