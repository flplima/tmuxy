use super::*;

#[test]
fn window_type_round_trip() {
    for ty in [
        WindowType::Tab,
        WindowType::Float,
        WindowType::SidebarLeft,
        WindowType::SidebarRight,
    ] {
        let s = ty.as_str();
        assert_eq!(WindowType::parse(s), Some(ty));
    }
    assert_eq!(WindowType::parse("workspace"), None);
    assert_eq!(WindowType::parse(""), None);
}

#[test]
fn window_type_serializes_as_kebab() {
    let ty = WindowType::SidebarLeft;
    let json = serde_json::to_string(&ty).unwrap();
    assert_eq!(json, "\"sidebar-left\"");
    let back: WindowType = serde_json::from_str(&json).unwrap();
    assert_eq!(back, WindowType::SidebarLeft);
}

/// A delta with nothing set is dropped, and that is the whole point — but
/// a delta carrying ANY change must survive, whatever the change is.
#[test]
fn a_pane_delta_is_empty_only_when_nothing_changed() {
    assert!(PaneDelta::default().is_empty());

    // The two that the old hand-written field list had missed or would
    // have missed. A dropped delta here is a pane state the tree never
    // shows, or a question the user is never asked.
    let state_only = PaneDelta {
        pane_state: Some(Some("needs-input".to_string())),
        ..Default::default()
    };
    assert!(
        !state_only.is_empty(),
        "a pane-state change must be emitted"
    );

    let ask_only = PaneDelta {
        pane_ask: Some(Some("eyJ0b2tlbiI6ImExIn0=".to_string())),
        ..Default::default()
    };
    assert!(!ask_only.is_empty(), "a pending question must be emitted");

    // Clearing is a change too: this is what answering the question, and
    // an agent unsetting its state on exit, look like on the wire.
    let cleared = PaneDelta {
        pane_ask: Some(None),
        ..Default::default()
    };
    assert!(!cleared.is_empty(), "clearing a question must be emitted");

    // And the common case still short-circuits before any serialization.
    let content_only = PaneDelta {
        content: Some(std::collections::HashMap::new()),
        ..Default::default()
    };
    assert!(!content_only.is_empty());
}

/// Each field on its own is a change worth emitting. A field added later
/// is covered without touching this list, because `is_empty` reads the
/// serialized form rather than naming fields — this walks the ones that
/// exist today to pin that behaviour down.
#[test]
fn every_pane_delta_field_makes_it_non_empty() {
    let all_fields = serde_json::json!({
        "window_id": "@1",
        "cursor_x": 1,
        "cursor_y": 2,
        "width": 80,
        "height": 24,
        "x": 0,
        "y": 1,
        "active": true,
        "command": "zsh",
        "title": "t",
        "border_title": "b",
        "group_id": "g5",
        "pane_state": "working",
        "pane_ask": "eyJ0b2tlbiI6ImExIn0=",
        "in_mode": true,
        "copy_cursor_x": 1,
        "copy_cursor_y": 2,
        "alternate_on": true,
        "mouse_any_flag": true,
        "marked": true,
        "paused": true,
        "history_size": 10,
        "selection_present": true,
        "selection_start_x": 1,
        "selection_start_y": 2,
        "images": [],
        "cursor_shape": 2,
        "cursor_hidden": true,
    });
    let keys: Vec<String> = all_fields
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.to_string())
        .collect();

    // Setting each field ALONE must produce a non-empty delta.
    for key in &keys {
        let one = serde_json::json!({ key.as_str(): all_fields[key].clone() });
        let delta: PaneDelta = serde_json::from_value(one).unwrap();
        assert!(
            !delta.is_empty(),
            "a delta carrying only `{key}` was dropped"
        );
    }
}

/// The window twin of the test above: `WindowDelta::is_empty` reads the
/// serialized form too, so every field, alone, is a change that survives.
#[test]
fn every_window_delta_field_makes_it_non_empty() {
    assert!(WindowDelta::default().is_empty());

    let all_fields = serde_json::json!({
        "index": 2,
        "name": "shell",
        "active": true,
        "window_type": "float",
        "float_parent": "@1",
        "float_width": 80,
        "float_height": 24,
        "float_drawer": "bottom",
        "float_bg": "dim",
        "float_noheader": true,
        "sidebar_cols": 30,
        "sidebar_hidden": true,
        "collapsible": true,
        "zoomed": true,
        "active_pane_id": "%3",
        "pane_tree": { "vertical": true, "children": ["%1", "%3"] },
    });
    let fields = all_fields.as_object().unwrap();

    for (key, value) in fields {
        let one = serde_json::json!({ key.as_str(): value.clone() });
        let delta: WindowDelta = serde_json::from_value(one).unwrap();
        assert!(
            !delta.is_empty(),
            "a delta carrying only `{key}` was dropped"
        );
    }

    // Clearing a nested option is a change too: `float_parent: null` is
    // how a float that re-docks reaches the client.
    let cleared = WindowDelta {
        float_parent: Some(None),
        ..Default::default()
    };
    assert!(!cleared.is_empty(), "clearing a field must be emitted");
}

mod vt100_capture_test {
    #[test]
    fn test_sgr_dim_faint_propagates_to_cell_style() {
        // SGR 2 (faint/dim) — used by Claude Code's TUI for autosuggestion text.
        // vt100 0.15 silently dropped this; 0.16 propagates it as cell.dim().
        // \e[2m turns on dim, \e[22m turns it off, \e[0m fully resets.
        let bytes = b"\x1b[2mdim\x1b[22m bright\x1b[2mD\x1b[0mP";
        let mut terminal = vt100::Parser::new(1, 32, 0);
        terminal.process(bytes);

        let cells = crate::extract_cells_from_screen(terminal.screen());
        let row = &cells[0];

        let is_dim = |col: usize| {
            row.get(col)
                .expect("cell present")
                .style
                .as_ref()
                .is_some_and(|s| s.dim)
        };

        // Column layout for "\x1b[2mdim\x1b[22m bright\x1b[2mD\x1b[0mP":
        //   0..2: 'd','i','m' (dim on)
        //   3:    ' '         (dim off)
        //   4..9: 'b','r','i','g','h','t'
        //   10:   'D'         (dim on again)
        //   11:   'P'         (dim off via SGR 0)
        assert!(is_dim(0), "'d' should be dim");
        assert!(is_dim(1), "'i' should be dim");
        assert!(is_dim(2), "'m' should be dim");
        assert!(!is_dim(4), "'b' (in 'bright') should not be dim");
        assert!(!is_dim(9), "'t' (end of 'bright') should not be dim");
        assert!(is_dim(10), "'D' after re-enabling SGR 2 should be dim");
        assert!(!is_dim(11), "'P' after SGR 0 should not be dim");
    }

    /// Feed `text` to a fresh 1×20 emulator and return the cursor column plus
    /// the non-empty cell contents in order — the shape tmux's grid would have
    /// (`screen_write_combine`), which is the oracle for these cases: tmux
    /// reports `#{cursor_x}` from ITS grid, so any width disagreement here
    /// shows up as text drifting off the grid in the browser.
    fn combined_cells(text: &str) -> (u16, Vec<String>) {
        let mut terminal = vt100::Parser::new(1, 20, 0);
        terminal.process(text.as_bytes());
        let screen = terminal.screen();
        let (_, col) = screen.cursor_position();
        let cells = (0..20)
            .filter_map(|c| screen.cell(0, c))
            .filter(|cell| cell.has_contents())
            .map(|cell| cell.contents().to_string())
            .collect();
        (col, cells)
    }

    #[test]
    fn zwj_sequence_is_one_wide_cell() {
        // 👩 + ZWJ + 💻: tmux joins the character after a ZWJ into the same
        // cell, so the sequence is one 2-column glyph — not 👩 + 💻 (4 columns).
        let (col, cells) = combined_cells("👩\u{200D}💻X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["👩\u{200D}💻", "X"]);
    }

    #[test]
    fn zwj_sequence_that_outgrows_the_cell_starts_a_new_character() {
        // 👨‍👩‍👧‍👦 is 25 bytes; the cell holds 22, so the last member is
        // written as its own wide character (tmux: same rule, 21-byte cells).
        let (col, cells) = combined_cells("👨\u{200D}👩\u{200D}👧\u{200D}👦X");
        assert_eq!(col, 5);
        assert_eq!(cells, vec!["👨\u{200D}👩\u{200D}👧\u{200D}", "👦", "X"]);
    }

    #[test]
    fn skin_tone_modifier_joins_its_emoji() {
        // U+1F3FD is itself East Asian Wide; without the tmux rule it would
        // take two more columns after 👍.
        let (col, cells) = combined_cells("👍\u{1F3FD}X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["👍\u{1F3FD}", "X"]);
    }

    #[test]
    fn skin_tone_modifier_after_a_non_emoji_is_its_own_character() {
        let (col, cells) = combined_cells("a\u{1F3FD}X");
        assert_eq!(col, 4);
        assert_eq!(cells, vec!["a", "\u{1F3FD}", "X"]);
    }

    #[test]
    fn variation_selector_widens_its_character() {
        // ❤ + VS16 is a 2-column cell, as tmux has it: its
        // `variation-selector-always-wide` defaults to on (tmux 3.7c puts the
        // cursor at column 3 after it). A 1-column cell here left every later
        // cell a column short of tmux's grid.
        let (col, cells) = combined_cells("\u{2764}\u{FE0F}X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["\u{2764}\u{FE0F}", "X"]);
    }

    /// The background a row's cells carry, from the first column of `text`.
    fn row_backgrounds(text: &str) -> Vec<(String, Option<crate::CellColor>)> {
        let mut terminal = vt100::Parser::new(1, 20, 0);
        terminal.process(text.as_bytes());
        crate::extract_cells_from_screen(terminal.screen())[0]
            .iter()
            .map(|cell| {
                let bg = cell.style.as_ref().and_then(|s| s.bg.clone());
                (cell.char.clone(), bg)
            })
            .collect()
    }

    #[test]
    fn a_wide_character_paints_its_continuation_in_its_own_background() {
        // An editor's cursor line is a coloured row. The half of ✅ that lies
        // in the second column used to be cleared to the default background,
        // so the row showed a black hole beside every wide glyph on it.
        let cells = row_backgrounds("\x1b[48;5;237m\u{2705}X");
        assert_eq!(
            cells[0],
            ("\u{2705}".to_string(), Some(crate::CellColor::Indexed(237)))
        );
        assert_eq!(
            cells[1],
            (" ".to_string(), Some(crate::CellColor::Indexed(237)))
        );
        assert_eq!(
            cells[2],
            ("X".to_string(), Some(crate::CellColor::Indexed(237)))
        );
    }

    #[test]
    fn a_character_widened_by_what_follows_keeps_its_background_too() {
        // A flag is two narrow indicators until the second arrives and widens
        // the first — a separate path that cleared the new half the same way.
        let cells = row_backgrounds("\x1b[48;5;237m\u{1F1FA}\u{1F1F8}X");
        assert_eq!(
            cells[1],
            (" ".to_string(), Some(crate::CellColor::Indexed(237)))
        );
        assert_eq!(
            cells[2],
            ("X".to_string(), Some(crate::CellColor::Indexed(237)))
        );
    }

    #[test]
    fn regional_indicator_pair_is_one_wide_cell() {
        // 🇺🇸: two 1-column indicators become one 2-column flag; a third
        // indicator starts a new (unpaired) flag cell.
        let (col, cells) = combined_cells("\u{1F1FA}\u{1F1F8}\u{1F1E9}X");
        assert_eq!(col, 4);
        assert_eq!(cells, vec!["\u{1F1FA}\u{1F1F8}", "\u{1F1E9}", "X"]);
        let screen_cells = {
            let mut terminal = vt100::Parser::new(1, 20, 0);
            terminal.process("\u{1F1FA}\u{1F1F8}".as_bytes());
            let screen = terminal.screen();
            (
                screen.cell(0, 0).unwrap().is_wide(),
                screen.cell(0, 1).unwrap().is_wide_continuation(),
            )
        };
        assert_eq!(screen_cells, (true, true));
    }

    #[test]
    fn hangul_filler_and_dangling_joiners_are_dropped() {
        // U+3164 is ignored outright; a ZWJ / VS16 at column 0 has nothing to
        // attach to and is discarded rather than drawn.
        let (col, cells) = combined_cells("\u{3164}\u{200D}\u{FE0F}X");
        assert_eq!(col, 1);
        assert_eq!(cells, vec!["X"]);
    }

    #[test]
    fn combining_mark_joins_a_wide_character_through_its_continuation() {
        // The cell before the cursor is 中's continuation half; the accent
        // must land on 中 itself.
        let (col, cells) = combined_cells("中\u{0301}X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["中\u{0301}", "X"]);
    }
}

mod pane_delta_marked_tests {
    use super::PaneDelta;

    /// A mark toggle is often the ONLY thing that changes about a pane; a delta
    /// carrying just `marked` must not be classified as empty, or it is never
    /// sent and the flag waits for the next full snapshot.
    #[test]
    fn a_delta_with_only_the_marked_flag_is_not_empty() {
        let delta = PaneDelta {
            marked: Some(true),
            ..PaneDelta::default()
        };
        assert!(!delta.is_empty());
        assert!(PaneDelta::default().is_empty());
    }
}

/// A pane's content is kept between updates, so a line holds only the cells
/// it shows: a short or blank row does not keep a whole row's worth of room.
#[test]
fn an_extracted_line_keeps_no_room_beyond_its_cells() {
    let mut parser = vt100::Parser::new(5, 200, 0);
    parser.process(b"hi\r\n");
    let lines = extract_cells_from_screen(parser.screen());
    assert_eq!(lines[0].len(), 2);
    assert!(
        lines[0].capacity() < 200,
        "capacity {}",
        lines[0].capacity()
    );
    assert!(lines[1].is_empty());
    assert!(
        lines[1].capacity() < 200,
        "capacity {}",
        lines[1].capacity()
    );
}

/// Control mode reads a command per line: a value holding a newline (a
/// multi-line clipboard) must stay on one, or what follows it runs as a
/// command of its own.
#[test]
fn a_quoted_value_never_spans_two_command_lines() {
    assert_eq!(crate::tmux_quote("it's"), r"'it'\''s'");
    let quoted = crate::tmux_quote("a\nkill-server\r$HOME \"x\"");
    assert!(!quoted.contains(['\n', '\r']), "{quoted}");
    assert_eq!(quoted, r#""a\012kill-server\015\$HOME \"x\"""#);
    assert_eq!(
        crate::tmux_double_quoted("~root/dir\u{009b}201~"),
        r#""\176root/dir\302\233201~""#
    );
}
