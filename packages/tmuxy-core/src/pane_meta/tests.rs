use super::*;

fn field(value: &str, until: Option<u64>) -> Field {
    Field {
        value: value.into(),
        until,
    }
}

#[test]
fn a_field_name_is_short_and_plain() {
    for key in [
        "ci",
        "build-2",
        "agent_task",
        "a",
        "abcdefghijklmnopqrstuvwx",
    ] {
        assert_eq!(check_key(key), Ok(()), "{key}");
    }
    for key in [
        "",
        "CI",
        "2fast",
        "-x",
        "with space",
        "é",
        "a.b",
        "abcdefghijklmnopqrstuvwxy",
    ] {
        assert!(check_key(key).is_err(), "{key}");
    }
}

#[test]
fn a_value_is_one_line_of_plain_text_and_never_cut() {
    assert_eq!(clean_value("  passing  ").as_deref(), Ok("passing"));
    assert_eq!(clean_value("a\tb\nc\x1b[31m").as_deref(), Ok("abc[31m"));
    assert_eq!(clean_value("✓ 12/12 tests").as_deref(), Ok("✓ 12/12 tests"));
    // Right-to-left overrides and zero-width characters, which make text
    // read as what it does not say, go with the controls.
    assert_eq!(
        clean_value("pass\u{202E}gnil\u{202C}iaf\u{200B}ed\u{FEFF}").as_deref(),
        Ok("passgniliafed")
    );
    assert!(clean_value("\u{200B}\u{202E}").is_err());
    assert!(clean_value("").is_err());
    assert!(clean_value(" \n\t ").is_err());
    let long = "x".repeat(MAX_VALUE_CHARS + 1);
    assert!(clean_value(&long).is_err());
    let at_limit = "é".repeat(MAX_VALUE_CHARS);
    assert_eq!(clean_value(&at_limit).as_deref(), Ok(at_limit.as_str()));
}

#[test]
fn fields_survive_the_option_and_anything_else_reads_as_none() {
    let fields = Fields::from([
        (
            "ci".to_string(),
            field("passing, 3 jobs\twith tabs gone", None),
        ),
        (
            "task".to_string(),
            field("rewrite the parser", Some(1_700_000_000)),
        ),
    ]);
    let cleaned: Fields = fields
        .iter()
        .map(|(k, f)| (k.clone(), field(&clean_value(&f.value).unwrap(), f.until)))
        .collect();
    let option = encode(&cleaned);
    // Nothing a tab-separated listing would split on.
    assert!(option
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)));
    assert_eq!(decode(&option), cleaned);
    assert_eq!(encode(&Fields::new()), "");
    assert_eq!(decode(""), Fields::new());

    let b64 = |json: &str| base64::engine::general_purpose::STANDARD.encode(json);
    for bad in [
        "not base64 at all!".to_string(),
        b64("[1, 2]"),
        b64(r#"{"ci": "no object"}"#),
        b64(r#"{"CI": {"v": "upper-case key"}}"#),
        b64(r#"{"ci": {"v": "line\nbreak"}}"#),
        b64(r#"{"ci": {"v": ""}}"#),
        b64(&format!(
            r#"{{"ci": {{"v": "{}"}}}}"#,
            "x".repeat(MAX_VALUE_CHARS + 1)
        )),
        b64(&format!(
            "{{{}}}",
            (0..=MAX_FIELDS)
                .map(|i| format!(r#""k{i}": {{"v": "x"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        )),
    ] {
        assert_eq!(decode(&bad), Fields::new(), "{bad}");
    }
}

#[test]
fn a_field_whose_time_is_up_is_gone() {
    let fields = Fields::from([
        ("always".to_string(), field("here", None)),
        ("soon".to_string(), field("going", Some(100))),
        ("later".to_string(), field("staying", Some(200))),
    ]);
    let at_100 = live(fields.clone(), 100);
    assert_eq!(at_100.keys().collect::<Vec<_>>(), ["always", "later"]);
    assert_eq!(live(fields, 99).len(), 3);
}

#[test]
fn a_time_to_live_is_a_number_and_a_unit() {
    assert_eq!(parse_ttl("30s"), Ok(30));
    assert_eq!(parse_ttl("5m"), Ok(300));
    assert_eq!(parse_ttl("2h"), Ok(7200));
    assert_eq!(parse_ttl("1d"), Ok(86_400));
    for bad in [
        "",
        "5",
        "m",
        "0m",
        "-5m",
        "5 m",
        "5min",
        "1.5h",
        "99999999999999999999d",
    ] {
        assert!(parse_ttl(bad).is_err(), "{bad}");
    }
}
