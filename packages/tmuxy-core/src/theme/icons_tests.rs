use super::*;

fn icons_of(lines: &[&str]) -> Value {
    parse(lines.iter().copied())
}

#[test]
fn a_glyph_or_an_image_file_is_a_process_icon_and_anything_else_is_dropped() {
    let icons = icons_of(&[
        "@tmuxy-icon-claude \"✻\"",
        "@tmuxy-icon-Codex openai.svg",
        "@tmuxy-icon-nvim \"\u{e62b} \"",
        "@tmuxy-css-term-red #ff0000",
        // A path out of icons/, a hidden file, an unknown type, a label
        // rather than an icon, a control character, a smuggled data URL.
        "@tmuxy-icon-a ../secret.png",
        "@tmuxy-icon-b .hidden.svg",
        "@tmuxy-icon-c notes.txt",
        "@tmuxy-icon-d \"far too long\"",
        "@tmuxy-icon-e \"\u{7}\"",
        "@tmuxy-icon-f data:x",
        "@tmuxy-icon-g/h x",
    ]);
    assert_eq!(icons["filter"], "palette");
    let map = icons["map"].as_object().unwrap();
    assert_eq!(map["claude"], "✻");
    // Matched as the client matches a command: lowercased.
    assert_eq!(map["codex"], "openai.svg");
    assert_eq!(map["nvim"], "\u{e62b} ");
    assert_eq!(map.len(), 3, "{map:?}");
}

#[test]
fn the_filter_is_palette_none_or_a_theme_colour() {
    let filter =
        |value: &str| icons_of(&[&format!("@tmuxy-icon-filter {value}")])["filter"].clone();
    assert_eq!(filter("none"), "none");
    assert_eq!(filter("bright-blue"), "bright-blue");
    assert_eq!(filter("foreground"), "foreground");
    assert_eq!(filter("chartreuse"), "palette");
    // The filter is not a process.
    assert!(icons_of(&["@tmuxy-icon-filter none"])["map"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[test]
fn an_image_icon_is_sent_inline_and_one_that_cannot_be_read_is_dropped() {
    let dir = std::env::temp_dir().join(format!("tmuxy-icons-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("logo.svg"), "<svg/>").unwrap();
    std::fs::write(dir.join("big.png"), vec![0u8; MAX_IMAGE_BYTES as usize + 1]).unwrap();
    let mut icons = icons_of(&[
        "@tmuxy-icon-agent logo.svg",
        "@tmuxy-icon-gone missing.png",
        "@tmuxy-icon-huge big.png",
        "@tmuxy-icon-zsh $",
    ]);
    inline_images(&mut icons, &dir);
    let map = icons["map"].as_object().unwrap();
    assert_eq!(
        map["agent"],
        format!("data:image/svg+xml;base64,{}", STANDARD.encode("<svg/>"))
    );
    assert_eq!(map["zsh"], "$");
    assert!(!map.contains_key("gone") && !map.contains_key("huge"));
    std::fs::remove_dir_all(&dir).unwrap();
}
