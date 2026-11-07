use super::capture_to_html;

/// The rows between the `<pre>` and the `</pre>`.
fn rows(capture: &str) -> Vec<String> {
    let html = capture_to_html(capture);
    let body = html
        .strip_prefix("<pre class=\"tmuxy-capture\">\n")
        .and_then(|rest| rest.strip_suffix("</pre>\n"))
        .unwrap_or_else(|| panic!("not one <pre>: {html:?}"));
    body.lines().map(str::to_string).collect()
}

fn row(capture: &str) -> String {
    let rows = rows(capture);
    assert_eq!(rows.len(), 1, "{rows:?}");
    rows[0].clone()
}

#[test]
fn the_capture_is_one_pre_with_a_line_per_row() {
    assert_eq!(
        capture_to_html("one\n\ntwo\n"),
        "<pre class=\"tmuxy-capture\">\none\n\ntwo\n</pre>\n"
    );
}

#[test]
fn the_sixteen_colours_are_palette_classes() {
    assert_eq!(
        row("\x1b[31mred\x1b[0m \x1b[92mbright\x1b[39m \x1b[44mb\x1b[103mB\x1b[49m"),
        "<span class=\"fg-1\">red</span> <span class=\"fg-10\">bright</span> \
         <span class=\"bg-4\">b</span><span class=\"bg-11\">B</span>"
    );
}

#[test]
fn the_256_colours_are_palette_classes() {
    assert_eq!(
        row("\x1b[38;5;208mx\x1b[48;5;17my\x1b[0m"),
        "<span class=\"fg-208\">x</span><span class=\"fg-208 bg-17\">y</span>"
    );
}

#[test]
fn a_true_colour_is_inline() {
    assert_eq!(
        row("\x1b[1;38;2;1;2;3;48;2;4;5;6mz\x1b[0m"),
        "<span class=\"bold\" style=\"color:rgb(1,2,3);background:rgb(4,5,6);\">z</span>"
    );
}

#[test]
fn each_attribute_is_a_class_and_its_sgr_off_ends_it() {
    assert_eq!(
        row("\x1b[1mb\x1b[22;3mi\x1b[23;4mu\x1b[24;7mr\x1b[27;2md\x1b[22mplain"),
        "<span class=\"bold\">b</span><span class=\"italic\">i</span>\
         <span class=\"underline\">u</span><span class=\"inverse\">r</span>\
         <span class=\"dim\">d</span>plain"
    );
    assert_eq!(
        row("\x1b[7;4;1;31mall\x1b[0m"),
        "<span class=\"bold underline inverse fg-1\">all</span>"
    );
}

#[test]
fn a_reset_ends_every_attribute_and_colour() {
    assert_eq!(
        row("\x1b[1;31ma\x1b[0mb\x1b[1;42mc\x1b[md"),
        "<span class=\"bold fg-1\">a</span>b<span class=\"bold bg-2\">c</span>d"
    );
}

#[test]
fn text_is_escaped_inside_a_span_and_out() {
    assert_eq!(
        row("<a href=\"x\">&</a> \x1b[31m<&\">\x1b[0m"),
        "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt; <span class=\"fg-1\">&lt;&amp;&quot;&gt;</span>"
    );
}

/// tmux carries the style from one line to the next without restating it.
#[test]
fn a_style_carries_across_a_line_break() {
    assert_eq!(
        rows("\x1b[31mone\ntwo\x1b[0m three\n"),
        [
            "<span class=\"fg-1\">one</span>",
            "<span class=\"fg-1\">two</span> three"
        ]
    );
}

#[test]
fn a_row_ends_at_its_last_written_cell() {
    assert_eq!(
        rows("short\na much longer line\n"),
        ["short", "a much longer line"]
    );
    assert_eq!(row("kept  "), "kept  ");
    assert_eq!(row("x\x1b[41m  \x1b[0m"), "x<span class=\"bg-1\">  </span>");
}

#[test]
fn a_wide_character_is_one_character() {
    assert_eq!(
        row("中文 \x1b[1m字\x1b[0m."),
        "中文 <span class=\"bold\">字</span>."
    );
}

#[test]
fn a_tab_keeps_the_line_on_one_row() {
    assert_eq!(row("a\tb\tc"), "a       b       c");
}

#[test]
fn escapes_that_are_not_sgr_leave_only_their_text() {
    assert_eq!(
        row("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b(0qq\x1b(B"),
        "link qq"
    );
}
