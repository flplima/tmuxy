use super::*;

fn icons_of(lines: &[&str]) -> Map<String, Value> {
    parse(lines.iter().copied())
}

#[test]
fn ascii_text_or_an_svg_file_is_a_process_icon_and_anything_else_is_dropped() {
    let icons = icons_of(&[
        "@tmuxy-icon-claude \"*\"",
        "@tmuxy-icon-Codex openai.SVG",
        "@tmuxy-icon-nvim \">_\"",
        // As tmux prints a bare `$`: escaped.
        "@tmuxy-icon-bash \\$",
        "@tmuxy-css-term-red #ff0000",
        // A path out of icons/, a hidden file, an image that is not an SVG,
        // a label rather than an icon, a glyph past ASCII, a control
        // character, blank, a smuggled data URL, a name that is no process.
        "@tmuxy-icon-a ../secret.svg",
        "@tmuxy-icon-b .hidden.svg",
        "@tmuxy-icon-c logo.png",
        "@tmuxy-icon-d \"far too long\"",
        "@tmuxy-icon-e \"✻\"",
        "@tmuxy-icon-f \"\u{7}\"",
        "@tmuxy-icon-g \"  \"",
        "@tmuxy-icon-h data:x",
        "@tmuxy-icon-i/j x",
    ]);
    let map = &icons;
    assert_eq!(map["claude"], "*");
    // Matched as the client matches a command: lowercased.
    assert_eq!(map["codex"], "openai.SVG");
    assert_eq!(map["nvim"], ">_");
    assert_eq!(map["bash"], "$");
    assert_eq!(map.len(), 4, "{map:?}");
}

#[test]
fn an_svg_icon_is_sent_inline_and_one_that_cannot_be_read_is_dropped() {
    let dir = std::env::temp_dir().join(format!("tmuxy-icons-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
    std::fs::write(dir.join("logo.svg"), svg).unwrap();
    std::fs::write(dir.join("fake.svg"), "not an svg").unwrap();
    std::fs::write(dir.join("big.svg"), "<svg>".repeat(MAX_SVG_BYTES as usize)).unwrap();
    let mut icons = icons_of(&[
        "@tmuxy-icon-agent logo.svg",
        "@tmuxy-icon-gone missing.svg",
        "@tmuxy-icon-fake fake.svg",
        "@tmuxy-icon-huge big.svg",
        "@tmuxy-icon-zsh $",
    ]);
    inline_svgs(&mut icons, &dir);
    let map = &icons;
    assert_eq!(
        map["agent"],
        format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg))
    );
    assert_eq!(map["zsh"], "$");
    assert_eq!(map.len(), 2, "{map:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}
