//! User-option keys tmuxy sets on tmux windows, panes and the global
//! session, all `@tmuxy-*` so they cannot collide with tmux's own options or
//! a user's plugins. The schema is in docs/TMUX-TAGS.md.

/// Type discriminator, set only on non-tab windows (`float`,
/// `sidebar-left`, `sidebar-right`). Tabs carry no marker
/// — an untagged window in the attached session IS a tab. See
/// [`crate::WindowType`].
pub const WINDOW_TYPE: &str = "@tmuxy-window-type";

/// Window ID this float is anchored to.
pub const FLOAT_PARENT: &str = "@tmuxy-float-parent";
/// Float dimensions in terminal cells.
pub const FLOAT_WIDTH: &str = "@tmuxy-float-width";
pub const FLOAT_HEIGHT: &str = "@tmuxy-float-height";
/// Drawer attachment edge (`top`/`bottom`/`left`/`right`).
pub const FLOAT_DRAWER: &str = "@tmuxy-float-drawer";
/// Backdrop style for the float (`dim`/`blur`/unset).
pub const FLOAT_BG: &str = "@tmuxy-float-bg";
/// `1` to suppress the float's header chrome.
pub const FLOAT_NOHEADER: &str = "@tmuxy-float-noheader";

/// Width of a sidebar column in terminal columns, when the user has dragged
/// it off its default. Set on the sidebar window, so it survives a reload
/// and every client draws the width tmux sized the pane to. Unset: the
/// side's default (`sidebar_dock::LEFT_COLS` / `RIGHT_COLS`).
pub const SIDEBAR_COLS: &str = "@tmuxy-sidebar-cols";

/// Window-scoped flag on a sidebar column the user has closed: `1` while
/// hidden, unset while shown. Closing a column keeps its pane alive (the
/// dock's shell, the tree's widget), so the window's existence does not
/// mean "open".
pub const SIDEBAR_HIDDEN: &str = "@tmuxy-sidebar-hidden";
/// Window-scoped flag on a float the user has minimized: `1` while it
/// waits in the queue at the bottom of the tab, unset while it is shown.
/// Its pane keeps running either way.
pub const FLOAT_MINIMIZED: &str = "@tmuxy-float-minimized";
/// `1` while the window keeps only the first-level row that holds the
/// active pane expanded and collapses the others to one row per pane
/// (see `layout.rs`). Unset for a normally tiled window.
pub const COLLAPSIBLE: &str = "@tmuxy-collapsible";
/// Rows the dock's pane is sized to. The dock runs in the sidebar font,
/// whose rows are shorter than the pane grid's, so the column holds more
/// of them than the viewport does; the client sets this from its own row
/// height. Unset: the viewport's rows.
pub const SIDEBAR_ROWS: &str = "@tmuxy-sidebar-rows";

/// Session-scoped one-shot request from a shell helper to move the client's
/// keyboard focus somewhere the helper cannot reach itself: `left` or
/// `right` for the matching sidebar column, `panes` to leave one.
///
/// `packages/tmuxy-cli/bin/tmuxy/nav` sets it when a directional
/// `select-pane` is a no-op at the grid's edge and that edge has an open
/// sidebar: a sidebar's pane lives in another window, so `select-pane`
/// would switch the visible tab. Read as a `list-windows` column (session
/// scope puts it on every row); the client that acts on it unsets it.
pub const FOCUS_REQUEST: &str = "@tmuxy-focus-request";

/// How a pane says it should be brought back after a session restore
/// (`tmuxy pane restore-cmd`): a column of the pane rows
/// (`tmux_formats::PaneColumn::Restore`), and of `session_snapshot`'s
/// own query.
pub const PANE_RESTORE: &str = "@tmuxy-pane-restore";

/// Pane-scoped group identity (e.g. `g5`). Set on every member of a pane
/// group — the visible member (in the attached session) and each hidden
/// member (parked in the [`crate::constants::STASH_SESSION`]). Panes sharing
/// a value belong to the same group; membership is intrinsic to the pane and
/// follows it across a cross-session `swap-pane`, so there is no separate
/// membership list to keep in sync.
pub const GROUP_ID: &str = "@tmuxy-group-id";

/// Pane-scoped position of a member within its group (`0`, `1`, …), set
/// when the user reorders a group (`tmuxy pane group move`). Members
/// without one follow those with one, in pane-id order — which is the
/// whole order of a group nobody has rearranged.
pub const GROUP_POS: &str = "@tmuxy-group-pos";

/// Global revision the group scripts bump after a change tmux does not
/// announce; every pane inherits it, so the monitor's pane-metadata
/// subscription (`tmux_formats::subscribe_pane_titles_command`) fires.
pub const GROUP_REV: &str = "@tmuxy-group-rev";

/// Global inventory of the installed plugins' menu actions: base64 of a
/// JSON array (`plugins::inventory`). Read by the client with one query
/// whenever [`PLUGINS_REV`] changes; never part of a subscription itself.
pub const PLUGINS: &str = "@tmuxy-plugins";

/// Global revision of [`PLUGINS`] (a hash of its JSON). Rides the
/// pane-metadata subscription and the `list-panes` rows, as
/// [`GROUP_REV`] does, so a client learns of an install or a removal
/// within a second.
pub const PLUGINS_REV: &str = "@tmuxy-plugins-rev";

/// Pane-scoped state the pane declares about itself (`tmuxy pane state`).
/// Free-form; the client owns the vocabulary.
pub const PANE_STATE: &str = "@tmuxy-pane-state";

/// Pane-scoped: what the pane's program reported behind its state with
/// OSC 7501, as a report body (`state=blocked:kind=permission:msg=…`,
/// free text base64). Written by the host that read the report
/// (`control_mode/program_status.rs`), beside [`PANE_STATE`].
pub const PANE_STATUS: &str = "@tmuxy-pane-status";

/// Set by tmux on a pane a send was held back from, because the pane said
/// it needs the user (`crate::ask::deliver`): with the send's own token
/// after it (`@tmuxy-send-held-<token>`), so senders at once each read
/// their own. The send reads it back to know, and takes it off.
pub const SEND_HELD: &str = "@tmuxy-send-held";
/// A send waiting in line for a busy pane (`crate::ask::queue`), one
/// option per send: `@tmuxy-send-queued-<id>`, base64 of who and what.
pub const SEND_QUEUED: &str = "@tmuxy-send-queued";
/// The agent inbox bridge, a spike (docs/AGENT-INBOX.md): global, `on`
/// lets the agent hook record a session's inbox and `pane send --inbox`
/// post to it. Off unless set.
pub const SEND_INBOX: &str = "@tmuxy-send-inbox";
/// The path of the inbox socket of the agent session in a pane, recorded
/// by its SessionStart hook while [`SEND_INBOX`] is on. The path only,
/// never the session's token.
pub const AGENT_INBOX: &str = "@tmuxy-agent-inbox";

/// A pane's custom fields (`tmuxy pane meta`, `crate::pane_meta`): base64
/// of a JSON object, so any text survives the tab-separated pane listing
/// the sidebar tree reads them from. Unset for none.
pub const PANE_META: &str = "@tmuxy-meta";

/// Which items a pane's row in the sidebar tree shows, on which lines
/// (`set -g @tmuxy-tree-row 'process ports id / cwd branch / title /
/// fields'`). The user's to set; the client reads it with the sessions
/// poll (`tmuxy-ui/src/domain/rowTemplate.ts`). Unset for the default.
pub const TREE_ROW: &str = "@tmuxy-tree-row";

/// A name a script gave a pane (`tmuxy pane run --label`), which the CLI
/// accepts as a target in place of the pane id (`_resolve_target` in the
/// shell scripts' `_contract`).
pub const PANE_LABEL: &str = "@tmuxy-label";

/// Pane-scoped: the pane `tmuxy agent spawn` was run from, on the pane
/// it made.
pub const SPAWNED_BY: &str = "@tmuxy-spawned-by";

/// Pane-scoped: the agent `tmuxy agent spawn` started in the pane
/// (`claude`, `codex`, `gemini`, or a `cmd`'s program).
pub const AGENT: &str = "@tmuxy-agent";

/// Pane-scoped: when the pane's report was written (Unix seconds),
/// by `tmuxy pane report`. The report counts only while this is set.
pub const REPORT_AT: &str = "@tmuxy-report-at";

/// Pane-scoped: the agent session the pane runs, `<agent>:<uuid>`, from
/// its hooks; `tmuxy agent revive` resumes it. Never a command line.
pub const AGENT_SESSION: &str = "@tmuxy-agent-session";

/// Pane-scoped: `ok` when `tmuxy agent revive --check` last said the pane
/// can be revived, written by the `agent-revive --mark` script for the
/// pane menu to read. A display hint only: revive checks again when run.
pub const REVIVABLE: &str = "@tmuxy-revivable";

/// Pane-scoped: the state the screen rules last wrote on a pane whose
/// agent has no hooks (`host::socket_watch::agent_rules`). They change
/// [`PANE_STATE`] only while it still equals this, so a state anything
/// else declared is never overwritten.
pub const RULES_STATE: &str = "@tmuxy-rules-state";

/// Pane-scoped: why the screen rules wrote [`RULES_STATE`], as a token
/// (`dialog`, `changed`, `still`, `user:<file>:<rule>`) that `tmuxy pane
/// state explain` turns into words.
pub const RULES_WHY: &str = "@tmuxy-rules-why";

/// Pane-scoped pending confirmation, set by a send (`tmuxy pane send -t`,
/// the MCP endpoint's `pane_send_keys`, `crate::ask`) on the pane the keys
/// are meant for. The value is base64 of a JSON object
/// (`{token, caller, keys}`), so the payload survives the comma-separated
/// `list-panes` format that free text would break. Unset means no
/// question is pending.
pub const ASK: &str = "@tmuxy-ask";
/// Global, `on` only where no process ancestry can be read (the CheerpX
/// guest's config sets it). It turns the own-pane check off there: a
/// caller's claim to run in a pane then stands unproven. Anywhere else an unproven claim is refused
/// (`verified_own_pane`, packages/tmuxy-cli/bin/tmuxy/_contract).
pub const TRUST_PANE_CLAIMS: &str = "@tmuxy-trust-pane-claims";

/// Pane-scoped answer to the pending [`ASK`], written by the client the
/// user answered in and read back by the waiting sender (`crate::ask`).
/// The value is `<token>:yes` or `<token>:no` — the token pins the answer
/// to the question that was on screen, so a stale answer to a question
/// already withdrawn is ignored rather than acted on.
pub const ASK_ANSWER: &str = "@tmuxy-ask-answer";

/// Pane-scoped authorisation for a widget, written by `tmuxy-widget` on the
/// pane it runs in. The [`super::WIDGET_MARKER`] the widget prints is
/// pane OUTPUT — a crafted file, a commit message in `git log`, an ssh MOTD
/// — so the marker alone never turns a pane into a widget: the client
/// honours it only when this option names the same widget.
pub const PANE_WIDGET: &str = "@tmuxy-pane-widget";

/// The one file a `preview` pane may read, written by
/// `tmuxy-widget-preview` out of band and cleared when it exits; honoured
/// only while [`PANE_WIDGET`] is `preview` (`crate::preview`).
pub const PANE_PREVIEW: &str = "@tmuxy-pane-preview";

/// `1` when the preview was opened with `--net`: its page may load from
/// the network.
pub const PANE_PREVIEW_NET: &str = "@tmuxy-pane-preview-net";

/// The one git checkout a `diff` pane may read, written by
/// `tmuxy-widget-diff` out of band and cleared when it exits; honoured
/// only while [`PANE_WIDGET`] is `diff` (`crate::diff_review`).
pub const PANE_DIFF: &str = "@tmuxy-pane-diff";

/// Active CSS theme name: a file stem under `~/.config/tmuxy/themes/` (the
/// user's) or a built-in one.
pub const THEME: &str = "@tmuxy-theme";
/// Theme mode: `dark` / `light` / `auto` (follow the OS).
pub const THEME_MODE: &str = "@tmuxy-theme-mode";
/// `@tmuxy-css-<variable> <value>`: one CSS variable set on the page over
/// the theme file (`@tmuxy-css-term-background '#101010'` is
/// `--term-background: #101010`). One option per variable, so a script in
/// a pane can set a colour without writing a stylesheet.
pub const CSS_VAR_PREFIX: &str = "@tmuxy-css-";
/// `@tmuxy-icon-<process> <text|file.svg>`: the icon a pane running
/// `<process>` wears — see `theme/icons.rs`.
pub const ICON_PREFIX: &str = "@tmuxy-icon-";

/// Appearance: background alpha (0.0–1.0) of each surface, on every
/// platform — see [`crate::theme::Appearance`].
pub const OPACITY: &str = "@tmuxy-opacity";
pub const ACTIVE_PANE_OPACITY: &str = "@tmuxy-active-pane-opacity";
pub const INACTIVE_PANE_OPACITY: &str = "@tmuxy-inactive-pane-opacity";
pub const ACTIVE_TEXT_OPACITY: &str = "@tmuxy-active-text-opacity";
pub const INACTIVE_TEXT_OPACITY: &str = "@tmuxy-inactive-text-opacity";
/// `on`/`off`: native blur behind the window (macOS only; ignored elsewhere).
pub const BLUR: &str = "@tmuxy-blur";
/// `on`/`off`: whether the window is see-through at all. Off paints the
/// chrome and the pane surfaces opaque and clears the blur, leaving the
/// opacity and blur options as they are for when it goes back on.
pub const TRANSPARENCY: &str = "@tmuxy-transparency";

/// Session-scoped: the terminal profile the session uses
/// (`crate::profiles`), set with the profile's own values over the
/// global ones. Unset: the Default Profile, which changes nothing.
pub const PROFILE: &str = "@tmuxy-profile";
/// `on`/`off`: the UI's layout animations (pane morphs, swaps, resizes,
/// float keyframes). Off draws every change in place.
pub const ANIMATIONS: &str = "@tmuxy-animations";
/// `on`/`off`: whether the cursor blinks. An application that asks for a
/// specific cursor (DECSCUSR) is still obeyed; this is what happens when
/// it has not.
pub const CURSOR_BLINK: &str = "@tmuxy-cursor-blink";
/// `on`/`off`: whether `tmuxy pane send` into a pane the caller does
/// not own asks the user there first (`crate::ask`).
pub const SEND_ASK: &str = "@tmuxy-send-ask";
/// Comma list of caller process names and target pane ids whose sends
/// skip that question. Read by every sender (`crate::ask`).
pub const SEND_ALLOW: &str = "@tmuxy-send-allow";
/// Comma list of programs (`claude,agy`): a send into a pane whose
/// program in front is one of them skips that question — an agent's
/// prompt, which other agents may type into. Read where `SEND_ALLOW` is.
pub const SEND_ALLOW_INTO: &str = "@tmuxy-send-allow-into";
/// `on`/`off`: whether closing a pane or tab asks first while a pane in
/// it says it is `working` or `needs-input` (`@tmuxy-pane-state`).
pub const CONFIRM_CLOSE: &str = "@tmuxy-confirm-close";
/// `on`/`off`: whether a pane entering `needs-input` or `error` sends a
/// web push notification to the devices that turned them on
/// (`tmuxy-server/src/push.rs`).
pub const NOTIFY: &str = "@tmuxy-notify";
/// Integer: how many cards each row of the "all tabs" view holds.
pub const TAB_OVERVIEW_COLS: &str = "@tmuxy-tab-overview-cols";
/// `on`/`off`: a two-finger trackpad slide left/right switches tabs.
pub const GESTURE_SWIPE_TABS: &str = "@tmuxy-gesture-swipe-tabs";
/// `on`/`off`: pinching out zooms the pane under the fingers, pinching in
/// unzooms it.
pub const GESTURE_PINCH_ZOOM: &str = "@tmuxy-gesture-pinch-zoom";
/// `on`/`off`: pinching in on an unzoomed tab opens the "all tabs" view.
pub const GESTURE_PINCH_OVERVIEW: &str = "@tmuxy-gesture-pinch-overview";
/// `on`/`off`: the desktop app draws its menus natively (the macOS menu
/// bar, native popups everywhere). Off keeps the themed in-app menus.
pub const NATIVE_MENUS: &str = "@tmuxy-native-menus";
/// How the session is sized across clients of different viewports:
/// `smallest` (default), `largest`, `latest`, or a fixed `COLSxROWS` —
/// see [`crate::client_size::SizePolicy`].
pub const SIZE: &str = "@tmuxy-size";
