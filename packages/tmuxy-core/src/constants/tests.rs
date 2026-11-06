use super::*;
use tmux_formats::{
    Column, Field, PaneColumn, Row, RowBuilder, StashColumn, TmuxList, WindowColumn,
};

fn format_of(list: TmuxList) -> &'static str {
    let command = list.command();
    let start = command.find("-F '").expect("every list names its format") + "-F '".len();
    command[start..]
        .strip_suffix('\'')
        .expect("the format closes the command")
}

#[test]
fn every_list_row_has_one_field_per_column() {
    fn check<C: Column>(list: TmuxList) {
        let mut depth = 0usize;
        let mut separators = 0usize;
        for ch in format_of(list).chars() {
            match ch {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => separators += 1,
                _ => {}
            }
        }
        assert_eq!(separators + 1, C::ALL.len(), "{list:?}");
        for column in C::ALL {
            let format = column.field().format();
            assert!(
                format.starts_with("#{") && format.ends_with('}'),
                "every column is one tmux format: {column:?} {format}"
            );
        }
    }
    check::<PaneColumn>(TmuxList::Panes);
    check::<WindowColumn>(TmuxList::Windows);
    check::<StashColumn>(TmuxList::Stash);
}

#[test]
fn free_text_columns_are_comma_escaped() {
    let escaped = format!("#{{s/,/{}/:", tmux_formats::COMMA_ESCAPE);
    for format in [
        PaneColumn::Command.field(),
        PaneColumn::Title.field(),
        PaneColumn::BorderTitle.field(),
        PaneColumn::Restore.field(),
        WindowColumn::Name.field(),
        StashColumn::Command.field(),
        StashColumn::Title.field(),
    ]
    .map(Field::format)
    {
        assert!(
            format.starts_with(&escaped),
            "free text, unescaped: {format}"
        );
    }
    assert_eq!(tmux_formats::unescape_commas("a%2C b%2C c"), "a, b, c");
}

#[test]
fn a_built_row_reads_back_through_its_table() {
    let line = RowBuilder::<WindowColumn>::new()
        .set(WindowColumn::WindowId, "@3")
        .set(WindowColumn::Active, 1)
        .set(WindowColumn::Name, "build, test")
        .build();
    let row = Row::<WindowColumn>::parse(&line).expect("one field per column");
    assert_eq!(row.field(WindowColumn::WindowId), "@3");
    assert!(row.flag(WindowColumn::Active));
    assert_eq!(row.text(WindowColumn::Name), "build, test");
    assert_eq!(row.option(WindowColumn::WindowType), None);

    assert!(Row::<PaneColumn>::parse(&line).is_none());
}

/// `#{pane_in_mode}` is 1 for every tmux mode (view, tree, buffer, client),
/// and a pane the client took for copy mode vanished behind a scrollback view.
#[test]
fn list_panes_asks_which_mode_not_any_mode() {
    assert_eq!(
        PaneColumn::Mode.field(),
        Field::Format(tmux_formats::PANE_MODE_FLAG)
    );
    assert!(
        !TmuxList::Panes.command().contains("#{pane_in_mode}"),
        "list-panes must not use #{{pane_in_mode}} — it is 1 for view-mode too"
    );
    assert!(
        tmux_formats::PANE_MODE_FLAG.contains("#{==:#{pane_mode},copy-mode},1,")
            && tmux_formats::PANE_MODE_FLAG.contains("#{==:#{pane_mode},view-mode},2,0")
    );
}

/// tmux seeds `#{pane_title}` with the host name, which the pane header would
/// show instead of falling back to the process name.
#[test]
fn pane_lists_ask_for_the_app_set_title() {
    for list in [TmuxList::Panes, TmuxList::Stash] {
        let cmd = list.command();
        assert!(
            cmd.contains(tmux_formats::APP_PANE_TITLE),
            "{list:?} must request APP_PANE_TITLE, not a bare #{{pane_title}}"
        );
        assert_eq!(
            cmd.matches("#{pane_title}").count(),
            tmux_formats::APP_PANE_TITLE
                .matches("#{pane_title}")
                .count(),
            "{list:?} has a #{{pane_title}} outside APP_PANE_TITLE"
        );
    }
}

#[test]
fn the_stash_list_targets_the_stash_session_by_name() {
    assert!(TmuxList::Stash.command().contains(STASH_SESSION));
}

#[test]
fn pane_meta_subscription_watches_the_group_options_and_the_pane_state() {
    let cmd = tmux_formats::subscribe_pane_titles_command();
    assert!(cmd.contains(&format!("'{}:", tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME)));
    for opt in [
        tmux_options::GROUP_ID,
        tmux_options::GROUP_POS,
        tmux_options::GROUP_REV,
        tmux_options::PANE_STATE,
    ] {
        assert!(
            cmd.contains(&format!("#{{{opt}}}")),
            "the pane-metadata subscription is missing #{{{opt}}}"
        );
    }
}
