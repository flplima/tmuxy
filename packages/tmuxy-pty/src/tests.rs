//! The line discipline, keystroke by keystroke.

use super::*;

fn typed(keys: &[u8]) -> (Vec<u8>, Vec<Action>) {
    let mut ld = LineDiscipline::new();
    let mut shown = Vec::new();
    let mut rest = Vec::new();
    for action in ld.input(keys) {
        match action {
            Action::Echo(bytes) => shown.extend(bytes),
            other => rest.push(other),
        }
    }
    (shown, rest)
}

/// What a one-row terminal shows after `shown`: printable bytes written
/// at the cursor, backspace one column left. Wide characters take two.
fn screen(shown: &[u8]) -> (String, usize) {
    let mut cells: Vec<String> = Vec::new();
    let mut col: usize = 0;
    for c in String::from_utf8_lossy(shown).chars() {
        match c {
            '\x08' => col = col.saturating_sub(1),
            '\r' | '\n' => {}
            _ => {
                let width = c.width().unwrap_or(1).max(1);
                while cells.len() < col + width {
                    cells.push(" ".to_string());
                }
                cells[col] = c.to_string();
                for cell in cells.iter_mut().skip(col + 1).take(width - 1) {
                    cell.clear();
                }
                col += width;
            }
        }
    }
    (cells.concat().trim_end().to_string(), col)
}

#[test]
fn a_line_is_echoed_and_sent_on_enter() {
    let (shown, rest) = typed(b"ls -l\r");
    assert_eq!(shown, b"ls -l\r\n");
    assert_eq!(rest, vec![Action::Send(b"ls -l\n".to_vec())]);
}

#[test]
fn nothing_is_sent_before_enter() {
    assert_eq!(typed(b"echo hi").1, vec![]);
}

#[test]
fn backspace_erases_a_whole_utf8_character() {
    let (shown, rest) = typed("ação\x7f\x7fx\r".as_bytes());
    assert_eq!(rest, vec![Action::Send("açx\n".as_bytes().to_vec())]);
    assert_eq!(screen(&shown), ("açx".to_string(), 3));
}

#[test]
fn backspace_takes_a_wide_character_back_two_columns() {
    let (shown, rest) = typed("a日🔥\x7f\x7f".as_bytes());
    assert_eq!(rest, vec![]);
    assert_eq!(screen(&shown), ("a".to_string(), 1));
}

#[test]
fn backspace_on_an_empty_line_shows_nothing() {
    assert_eq!(typed(b"\x7f"), (vec![], vec![]));
}

#[test]
fn ctrl_u_and_ctrl_w_erase_the_line_and_the_last_word() {
    assert_eq!(typed(b"abc\x15x\r").1, vec![Action::Send(b"x\n".to_vec())]);
    assert_eq!(
        typed(b"git commit  \x17push\r").1,
        vec![Action::Send(b"git push\n".to_vec())]
    );
}

#[test]
fn the_arrows_move_the_cursor_and_typing_goes_in_there() {
    // A typo fixed two characters back: `ehco` → `echo`.
    let (shown, rest) = typed(b"ehco hi\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x7f\x1b[Ch\r");
    assert_eq!(rest, vec![Action::Send(b"echo hi\n".to_vec())]);
    assert_eq!(screen(&shown).0, "echo hi");
}

#[test]
fn home_end_and_delete_edit_anywhere_in_the_line() {
    let (shown, rest) = typed(b"xcho x\x1b[H\x1b[3~e\x1b[F!\r");
    assert_eq!(rest, vec![Action::Send(b"echo x!\n".to_vec())]);
    assert_eq!(screen(&shown).0, "echo x!");
    let (_, rest) = typed(b"bc\x01a\x05d\r");
    assert_eq!(rest, vec![Action::Send(b"abcd\n".to_vec())]);
}

#[test]
fn a_wide_character_moves_the_cursor_two_columns() {
    let (shown, _) = typed("日本\x1b[D".as_bytes());
    assert_eq!(screen(&shown), ("日本".to_string(), 2));
}

#[test]
fn ctrl_c_drops_the_line_and_interrupts() {
    let (shown, rest) = typed(b"sleep 9\x03");
    assert!(shown.ends_with(b"^C"));
    assert_eq!(rest, vec![Action::Interrupt]);
}

#[test]
fn ctrl_d_ends_input_only_on_an_empty_line() {
    assert_eq!(typed(b"\x04").1, vec![Action::EndOfInput]);
    assert_eq!(typed(b"ab\x04").1, vec![Action::Send(b"ab".to_vec())]);
}

#[test]
fn ctrl_l_asks_for_a_clear_screen_and_keeps_the_line() {
    let mut ld = LineDiscipline::new();
    assert_eq!(
        ld.input(b"ls\x0c"),
        vec![Action::Echo(b"ls".to_vec()), Action::ClearScreen]
    );
    assert_eq!(ld.line(), b"ls");
}

#[test]
fn arrows_recall_history_and_return_to_the_draft() {
    let mut ld = LineDiscipline::new();
    ld.input(b"one\rtwo\rdra");
    ld.input(b"\x1b[A\x1b[A");
    assert_eq!(ld.line, b"one");
    ld.input(b"\x1bOB\x1b[B");
    assert_eq!(ld.line, b"dra");
    assert_eq!(ld.input(b"\x1b[B"), vec![]);
    let sent = ld.input(b"\x1b[A\r");
    assert_eq!(sent.last(), Some(&Action::Send(b"two\n".to_vec())));
}

#[test]
fn other_escape_sequences_and_control_keys_are_dropped() {
    let (shown, rest) = typed(b"a\x1b[1;5C\x1b[15~\x07\x1bxb\r");
    assert_eq!(shown, b"ab\r\n");
    assert_eq!(rest, vec![Action::Send(b"ab\n".to_vec())]);
}

#[test]
fn tab_asks_for_the_word_before_the_cursor_to_be_completed() {
    let mut ld = LineDiscipline::new();
    assert_eq!(ld.input(b"ls /et\t").last(), Some(&Action::Complete));
    assert_eq!(ld.completion_word(), ("/et".to_string(), false));
    ld.type_text(b"c/");
    assert_eq!(ld.line(), b"ls /etc/");
    let mut ld = LineDiscipline::new();
    ld.input(b"  ech");
    assert_eq!(ld.completion_word(), ("ech".to_string(), true));
}

#[test]
fn the_common_prefix_of_completions() {
    let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        common_prefix(&names(&["hostname", "host", "hosts/"])),
        "host"
    );
    assert_eq!(common_prefix(&names(&["日本語", "日本"])), "日本");
    assert_eq!(common_prefix(&names(&["only"])), "only");
    assert_eq!(common_prefix(&[]), "");
}

#[test]
fn the_shell_directory_is_read_off_its_prompt() {
    assert_eq!(
        osc7_path(b"x\x1b]7;/root\x07y\x1b]7;/tmp/a b\x07$ "),
        Some("/tmp/a b".into())
    );
    assert_eq!(osc7_path(b"no report"), None);
}

#[test]
fn output_newlines_become_crlf() {
    assert_eq!(translate_output(b"a\nb\n"), b"a\r\nb\r\n");
}
