use super::*;
use tmux_formats::{Column, PaneColumn, Row, RowBuilder, StashColumn, TmuxList, WindowColumn};

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
