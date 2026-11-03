use super::*;

const CLAUDE_PERMISSION: &str = "\
● Bash(cargo test -p tmuxy-server)
  ⎿  Running…

╭──────────────────────────────────────────────────────────╮
│ Bash command                                             │
│                                                          │
│   cargo test -p tmuxy-server                             │
│   Run the server's tests                                 │
│                                                          │
│ Do you want to proceed?                                  │
│ ❯ 1. Yes                                                 │
│   2. Yes, and don't ask again for cargo test commands    │
│   3. No, and tell Claude what to do differently (esc)    │
╰──────────────────────────────────────────────────────────╯
";

const AGY_PERMISSION: &str = "\
  Requesting permission for: npm install lodash

  Do you want to proceed?
  > 1. Yes
    2. Yes, and always allow in this conversation for commands that start with 'npm install'
    3. Yes, and always allow for commands that start with 'npm install' (Persist to settings.json)
    4. No
";

const CODEX_APPROVAL: &str = "\
  Would you like to run the following command?

  $ rm -rf target

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)
";

const CLAUDE_COMPOSER: &str = "\
● Done. The tests pass.

  Would you like to commit this?

────────────────────────────────────────────────────────────
> 1. write the changelog
────────────────────────────────────────────────────────────
  ? for shortcuts
";

const CLAUDE_WORKING: &str = "\
● Reading the hook script.

✻ Photosynthesizing… (12s · ↓ 1.2k tokens · esc to interrupt)

────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────
";

#[test]
fn each_agents_approval_dialog_is_seen() {
    assert!(shows_dialog(CLAUDE_PERMISSION));
    assert!(shows_dialog(AGY_PERMISSION));
    assert!(shows_dialog(CODEX_APPROVAL));
    assert!(shows_dialog("Overwrite the file? (y/n)\n"));
}

#[test]
fn a_reply_that_asks_or_a_numbered_draft_is_not_a_dialog() {
    // The agent's own closing question has no options under it, and a draft
    // typed into the composer is one numbered line.
    assert!(!shows_dialog(CLAUDE_COMPOSER));
    assert!(!shows_dialog(CLAUDE_WORKING));
    assert!(!shows_dialog(""));
}

#[test]
fn a_dialog_scrolled_above_the_bottom_is_not_one() {
    let scrolled = format!(
        "{CLAUDE_PERMISSION}{}",
        "output line\n".repeat(BOTTOM_LINES)
    );
    assert!(!shows_dialog(&scrolled));
}

fn row(state: &str) -> Row {
    Row {
        pane_id: "%7".into(),
        command: "agy".into(),
        state: state.into(),
        asking: false,
    }
}

#[test]
fn a_dialog_marks_the_pane_and_its_answer_unmarks_it() {
    let mut corrector = Corrector::default();
    // Antigravity has no hook for the prompt: the screen marks it.
    assert_eq!(
        corrector.correct(&row("working"), true),
        Some("needs-input")
    );
    assert_eq!(corrector.correct(&row("needs-input"), true), None);
    // Answered: the dialog is gone and the tool runs.
    assert_eq!(
        corrector.correct(&row("needs-input"), false),
        Some("working")
    );
    assert_eq!(corrector.correct(&row("working"), false), None);
}

#[test]
fn a_needs_input_the_screen_never_backed_is_left_to_the_hooks() {
    let mut corrector = Corrector::default();
    // An MCP elicitation, say: a dialog the screen does not know.
    assert_eq!(corrector.correct(&row("needs-input"), false), None);
    // A send's question holds the pane whatever the screen shows.
    let asking = Row {
        asking: true,
        ..row("needs-input")
    };
    assert_eq!(corrector.correct(&asking, true), None);
    assert_eq!(corrector.correct(&asking, false), None);
    // An error or a cleared pane is the hooks' to change.
    assert_eq!(corrector.correct(&row("error"), true), None);
}

#[test]
fn a_pane_list_row_reads_into_its_fields() {
    let rows = parse_rows("%3\tclaude\tworking\t\n%4\tzsh\t\t\n%5\t2.1.30\tneeds-input\tMay I?\n");
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[0],
        Row {
            pane_id: "%3".into(),
            command: "claude".into(),
            state: "working".into(),
            asking: false,
        }
    );
    assert!(rows[2].asking);
    assert!(is_agent(&rows[0].command) && is_agent(&rows[2].command));
    assert!(!is_agent(&rows[1].command));
}
