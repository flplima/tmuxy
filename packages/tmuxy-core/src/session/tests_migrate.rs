//! What the migration drops from an older `tmuxy.conf`, and what it keeps:
//! `clean_user_conf` on the text alone, no directories involved.

use super::migrate::{clean_user_conf, StaleBlock};
use super::tests_layout::{CTRL_HJKL_BLOCK, CTRL_TAB_BLOCK, V014_CONF};
use super::*;

/// The old header goes line for line; a comment the user wrote right under
/// it, or one in a file that has nothing but comments past the template, is
/// theirs and stays.
#[test]
fn the_old_header_goes_and_the_users_comments_under_it_stay() {
    let notes = "# C-Space is for tmux, C-a for the shell\n# set -g @tmuxy-theme nord\n";
    let conf = V014_CONF.replacen("via the UI).\n", &format!("via the UI).\n{notes}"), 1);
    assert_ne!(conf, V014_CONF);
    let (cleaned, blocks) = clean_user_conf(&conf);
    assert_eq!(
        blocks,
        [
            StaleBlock::OldHeader,
            StaleBlock::DefaultsSourceLine,
            StaleBlock::ExamplesBlock
        ]
    );
    assert_eq!(cleaned, format!("{DEFAULT_USER_CONF}\n{notes}"));
    assert!(!cleaned.contains("Tmuxy User Configuration"));

    let header = V014_CONF.split("\n\n").next().unwrap();
    let (cleaned, blocks) = clean_user_conf(&format!("{header}\n\n{notes}"));
    assert_eq!(blocks, [StaleBlock::OldHeader]);
    assert_eq!(cleaned, format!("{DEFAULT_USER_CONF}\n{notes}"));

    let edited = conf.replacen("# Tmuxy never overwrites", "# I overwrite", 1);
    let (cleaned, blocks) = clean_user_conf(&edited);
    assert!(
        !blocks.contains(&StaleBlock::OldHeader),
        "an edited header is the user's"
    );
    assert!(cleaned.contains("# I overwrite") && cleaned.contains(notes));
}

#[test]
fn a_conf_with_nothing_stale_is_left_as_it_is() {
    let conf = "set -g prefix C-Space\nbind -n C-Tab next-window\n";
    assert_eq!(clean_user_conf(conf), (conf.to_string(), Vec::new()));
    assert_eq!(clean_user_conf(DEFAULT_USER_CONF).1, Vec::new());
}

/// A binding the defaults ship goes only when nothing else in the file binds
/// or unbinds the same key: after an `unbind -n C-h`, the restore is what
/// makes Ctrl+H navigate, and dropping it would change the key.
#[test]
fn a_restored_binding_stays_when_the_file_also_unbinds_the_key() {
    let conf = format!("unbind -n C-h{CTRL_HJKL_BLOCK}");
    let (cleaned, blocks) = clean_user_conf(&conf);
    assert!(!blocks.contains(&StaleBlock::CtrlHjklRestore));
    assert_eq!(cleaned, conf);

    let (cleaned, blocks) = clean_user_conf(&format!("{V014_CONF}{CTRL_TAB_BLOCK}"));
    assert_eq!(
        blocks,
        [
            StaleBlock::OldHeader,
            StaleBlock::DefaultsSourceLine,
            StaleBlock::ExamplesBlock,
            StaleBlock::CtrlTabUpgrade
        ]
    );
    assert_eq!(cleaned, DEFAULT_USER_CONF);
}
