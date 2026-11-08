use super::PaneState;
use crate::ids::test_ids::wid;
use crate::TmuxPane;

/// The pane as a client is sent it.
pub(crate) fn sent(pane: &mut PaneState) -> TmuxPane {
    pane.window_id.get_or_insert_with(|| wid("@0"));
    pane.build_tmux_pane()
        .expect("a pane with a window is sent")
}

/// The text a client is sent of the pane's screen, row by row, trailing blanks off.
pub(crate) fn sent_text(pane: &mut PaneState) -> String {
    sent(pane)
        .content
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.char.as_str())
                .collect::<String>()
        })
        .map(|row| row.trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}
