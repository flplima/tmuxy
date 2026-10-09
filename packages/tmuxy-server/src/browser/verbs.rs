//! What you can ask a browser session to do, and how a REPL line becomes one.
//!
//! The REPL in the pane, the CLI, and an agent calling the CLI all go through
//! this one list. Parsing is separated from doing so the grammar can be tested
//! exhaustively without a browser: a verb that silently takes the wrong argument
//! is the failure mode an agent cannot debug, because the page simply does
//! something else than it asked for.
//!
//! The grammar is deliberately shell-shaped rather than JSON: these lines are
//! typed by a person at a prompt and sent by `tmux send-keys` from a script, and
//! both of those are much happier with `click #submit` than with
//! `{"verb":"click","selector":"#submit"}`. The cost is that the LAST argument
//! of a verb takes the rest of the line verbatim — a selector or a URL can
//! contain spaces, and quoting would be a second grammar to get wrong.

/// Something a session can be asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verb {
    /// Navigate to a URL and wait for the load to settle.
    Goto { url: String },
    /// Evaluate JavaScript in the page and print the result.
    Eval { expression: String },
    /// Click the first element matching a selector.
    Click { selector: String },
    /// Focus a selector and type text into it.
    Type { selector: String, text: String },
    /// Wait until a selector exists.
    Wait { selector: String },
    /// Save a PNG screenshot; `None` means print the path the server chose.
    Shot { path: Option<String> },
    /// The page's `<title>`.
    Title,
    /// The page's current URL.
    Url,
    /// The visible text of the page, or of one selector.
    Text { selector: Option<String> },
    /// Go back in history.
    Back,
    /// Reload.
    Reload,
    /// The list of verbs, for a person who typed the wrong thing.
    Help,
}

/// Why a line could not become a verb.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// The line was blank. Not an error to report — a prompt that printed
    /// "unknown verb" every time someone pressed Enter would be unusable.
    Empty,
    Unknown {
        verb: String,
    },
    MissingArgument {
        verb: &'static str,
        needs: &'static str,
    },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, ""),
            Self::Unknown { verb } => {
                write!(f, "unknown verb `{verb}` — `help` lists them")
            }
            Self::MissingArgument { verb, needs } => {
                write!(f, "`{verb}` needs {needs}")
            }
        }
    }
}

/// One line of REPL input as a verb.
pub fn parse(line: &str) -> Result<Verb, ParseError> {
    let line = line.trim();
    if line.is_empty() {
        return Err(ParseError::Empty);
    }

    // The verb is the first word; everything after it is the rest, verbatim.
    // `split_once` rather than `split_whitespace` precisely so a selector, a
    // URL or an expression keeps its own spaces.
    //
    // INTERIOR whitespace is preserved; the ends are not. A selector, a URL or
    // an expression keeps its own spaces, which is the whole reason for
    // `split_once` over `split_whitespace`.
    //
    // Trailing whitespace is deliberately NOT preserved, including in the text
    // `type` sends. It would be nice to promise — a trailing space can be a
    // real character someone is typing into a field — but the transport cannot
    // keep the promise: a line reaches here through `tmux send-keys`, a pty and
    // a line reader, and whether the tail survives depends on which of them the
    // caller went through. A guarantee that holds for one caller and not
    // another is worse than a rule, so the rule is: the ends are trimmed. Text
    // that really needs an exact tail goes through `eval` with a string
    // literal, where JavaScript's own quoting makes it explicit.
    let (verb, rest) = match line.split_once(char::is_whitespace) {
        Some((verb, rest)) => (verb, rest.trim()),
        None => (line, ""),
    };

    let need =
        |needs: &'static str, verb: &'static str| ParseError::MissingArgument { verb, needs };

    match verb {
        "goto" | "open" => {
            if rest.is_empty() {
                return Err(need("a URL", "goto"));
            }
            Ok(Verb::Goto {
                url: normalise_url(rest),
            })
        }
        "eval" | "js" => {
            if rest.is_empty() {
                return Err(need("an expression", "eval"));
            }
            Ok(Verb::Eval {
                expression: rest.to_string(),
            })
        }
        "click" => {
            if rest.is_empty() {
                return Err(need("a selector", "click"));
            }
            Ok(Verb::Click {
                selector: rest.to_string(),
            })
        }
        "type" | "fill" => {
            // Two arguments, and the SECOND is the free-form one: a selector
            // cannot contain a space in practice, but the text being typed very
            // often does.
            let (selector, text) = rest
                .split_once(char::is_whitespace)
                .ok_or_else(|| need("a selector and some text", "type"))?;
            if selector.is_empty() {
                return Err(need("a selector and some text", "type"));
            }
            let text = text.trim_start();
            if text.is_empty() {
                return Err(need("a selector and some text", "type"));
            }
            Ok(Verb::Type {
                selector: selector.to_string(),
                // `trim_start` because the gap between the selector and the
                // text is a SEPARATOR, not content: `type #q   hello` types
                // "hello", not "  hello". Interior spaces are untouched — see
                // the note on the split above for why the ends cannot be
                // promised either way.
                text: text.to_string(),
            })
        }
        "wait" => {
            if rest.is_empty() {
                return Err(need("a selector", "wait"));
            }
            Ok(Verb::Wait {
                selector: rest.to_string(),
            })
        }
        "shot" | "screenshot" => Ok(Verb::Shot {
            path: (!rest.is_empty()).then(|| rest.to_string()),
        }),
        "title" => Ok(Verb::Title),
        "url" => Ok(Verb::Url),
        "text" => Ok(Verb::Text {
            selector: (!rest.is_empty()).then(|| rest.to_string()),
        }),
        "back" => Ok(Verb::Back),
        "reload" | "refresh" => Ok(Verb::Reload),
        "help" | "?" => Ok(Verb::Help),
        other => Err(ParseError::Unknown {
            verb: other.to_string(),
        }),
    }
}

/// Read a target the way a browser's address bar reads it.
///
/// The same rules `bin/tmuxy/tmuxy-widget-browser` already applies to the
/// widget's argument, so `goto localhost:3000` means in the REPL what
/// `tmuxy open localhost:3000` means at a shell. A person typing at a prompt
/// does not type a scheme, and refusing the line over it would be pedantry.
fn normalise_url(target: &str) -> String {
    // An explicit scheme is respected, whatever it is: `data:`, `file:`,
    // `about:blank` are all legitimate things to ask for.
    if target.contains("://") || target.starts_with("about:") || target.starts_with("data:") {
        return target.to_string();
    }
    // A local host gets http: nothing serves TLS on localhost by default, and
    // `https://localhost:3000` fails in a way that looks like the dev server is
    // down.
    let host = target.split('/').next().unwrap_or(target);
    let bare = host.split(':').next().unwrap_or(host);
    let is_local = bare == "localhost"
        || bare == "127.0.0.1"
        || bare == "0.0.0.0"
        || bare == "[::1]"
        || bare.ends_with(".local")
        || bare.ends_with(".localhost");
    let is_ip = !bare.is_empty()
        && bare.split('.').count() == 4
        && bare.split('.').all(|part| {
            !part.is_empty() && part.len() <= 3 && part.bytes().all(|b| b.is_ascii_digit())
        });

    if is_local || is_ip {
        format!("http://{target}")
    } else {
        format!("https://{target}")
    }
}

/// The verb list, as the REPL prints it.
pub const HELP: &str = "\
goto <url>              navigate (a bare host gets a scheme)
eval <js>               evaluate in the page and print the result
click <selector>        click the first match
type <selector> <text>  focus a selector and type
wait <selector>         block until a selector exists
text [selector]         the visible text of the page, or of one element
title                   the page's title
url                     the page's current URL
shot [path]             save a PNG
back                    history back
reload                  reload
help                    this list";

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_line_is_not_an_error_worth_printing() {
        assert_eq!(parse(""), Err(ParseError::Empty));
        assert_eq!(parse("   \t "), Err(ParseError::Empty));
        // A prompt that answered "unknown verb" to every bare Enter would be
        // unusable, so the caller is expected to print nothing for this.
        assert_eq!(ParseError::Empty.to_string(), "");
    }

    #[test]
    fn the_verbs_with_no_arguments_parse() {
        assert_eq!(parse("title"), Ok(Verb::Title));
        assert_eq!(parse("url"), Ok(Verb::Url));
        assert_eq!(parse("back"), Ok(Verb::Back));
        assert_eq!(parse("reload"), Ok(Verb::Reload));
        assert_eq!(parse("refresh"), Ok(Verb::Reload));
        assert_eq!(parse("help"), Ok(Verb::Help));
        assert_eq!(parse("?"), Ok(Verb::Help));
    }

    #[test]
    fn surrounding_whitespace_is_not_part_of_the_verb() {
        assert_eq!(parse("  title  "), Ok(Verb::Title));
        assert_eq!(
            parse("  click   #go  "),
            Ok(Verb::Click {
                selector: "#go".to_string()
            })
        );
    }

    /// The reason the grammar takes the rest of the line verbatim: a real
    /// selector has spaces in it, and `split_whitespace` would silently click
    /// the wrong thing.
    #[test]
    fn a_selector_keeps_its_spaces() {
        assert_eq!(
            parse("click div.card > button[type=\"submit\"]"),
            Ok(Verb::Click {
                selector: "div.card > button[type=\"submit\"]".to_string()
            })
        );
        assert_eq!(
            parse("wait ul li:nth-child(2) a"),
            Ok(Verb::Wait {
                selector: "ul li:nth-child(2) a".to_string()
            })
        );
    }

    /// An expression is code, and code is full of spaces.
    #[test]
    fn eval_takes_the_whole_rest_of_the_line() {
        assert_eq!(
            parse("eval document.querySelectorAll('a').length + 1"),
            Ok(Verb::Eval {
                expression: "document.querySelectorAll('a').length + 1".to_string()
            })
        );
    }

    /// `type` is the one verb with two arguments, and the free-form one is the
    /// second. Interior spaces in the TEXT are the normal case and must survive.
    #[test]
    fn type_splits_once_and_keeps_the_text_whole() {
        assert_eq!(
            parse("type #search hello world"),
            Ok(Verb::Type {
                selector: "#search".to_string(),
                text: "hello world".to_string(),
            })
        );
        assert_eq!(
            parse("type textarea.body first line  and  more"),
            Ok(Verb::Type {
                selector: "textarea.body".to_string(),
                text: "first line  and  more".to_string(),
            })
        );
    }

    /// The ends ARE trimmed, and that is a decision rather than an oversight: a
    /// line reaches the parser through `send-keys`, a pty and a line reader, and
    /// whether a trailing space survives depends which of those the caller used.
    /// A guarantee that holds for one caller and not another is worse than a
    /// rule — text needing an exact tail goes through `eval`.
    #[test]
    fn the_ends_of_typed_text_are_trimmed_because_the_transport_cannot_promise_them() {
        assert_eq!(
            parse("type #q  padded   "),
            Ok(Verb::Type {
                selector: "#q".to_string(),
                text: "padded".to_string(),
            })
        );
    }

    #[test]
    fn the_optional_arguments_are_optional() {
        assert_eq!(parse("shot"), Ok(Verb::Shot { path: None }));
        assert_eq!(
            parse("shot /tmp/page.png"),
            Ok(Verb::Shot {
                path: Some("/tmp/page.png".to_string())
            })
        );
        assert_eq!(parse("text"), Ok(Verb::Text { selector: None }));
        assert_eq!(
            parse("text main h1"),
            Ok(Verb::Text {
                selector: Some("main h1".to_string())
            })
        );
    }

    #[test]
    fn a_verb_missing_its_argument_says_what_it_needs() {
        for (line, needs) in [
            ("goto", "a URL"),
            ("eval", "an expression"),
            ("click", "a selector"),
            ("wait", "a selector"),
            ("type", "a selector and some text"),
            ("type  #only-a-selector", "a selector and some text"),
        ] {
            let error = parse(line).expect_err(line);
            let message = error.to_string();
            assert!(message.contains(needs), "{line:?} said {message:?}");
        }
    }

    #[test]
    fn an_unknown_verb_points_at_help() {
        let error = parse("teleport somewhere").expect_err("unknown");
        let message = error.to_string();
        assert!(message.contains("teleport"), "{message}");
        assert!(message.contains("help"), "{message}");
    }

    /// The aliases exist because the CLI already uses one spelling and a REPL
    /// user reaches for the other.
    #[test]
    fn the_aliases_mean_the_same_thing() {
        assert_eq!(parse("open example.com"), parse("goto example.com"));
        assert_eq!(parse("js 1+1"), parse("eval 1+1"));
        assert_eq!(parse("fill #a b"), parse("type #a b"));
        assert_eq!(parse("screenshot"), parse("shot"));
    }

    /// The same rules the widget's own argument already follows, so a REPL line
    /// and a `tmuxy open` argument mean the same thing.
    #[test]
    fn a_bare_host_gets_a_scheme_the_way_an_address_bar_reads_it() {
        assert_eq!(normalise_url("example.com"), "https://example.com");
        assert_eq!(
            normalise_url("example.com/docs"),
            "https://example.com/docs"
        );
        assert_eq!(normalise_url("localhost:3000"), "http://localhost:3000");
        assert_eq!(normalise_url("localhost"), "http://localhost");
        assert_eq!(normalise_url("127.0.0.1:9000"), "http://127.0.0.1:9000");
        assert_eq!(
            normalise_url("192.168.1.10:8080"),
            "http://192.168.1.10:8080"
        );
        assert_eq!(normalise_url("box.local:4848"), "http://box.local:4848");
    }

    /// Nothing serves TLS on localhost by default, and `https://localhost:3000`
    /// fails in a way that reads as "the dev server is down".
    #[test]
    fn a_local_host_gets_http_not_https() {
        for target in [
            "localhost:5173",
            "127.0.0.1",
            "0.0.0.0:8000",
            "dev.localhost",
        ] {
            assert!(
                normalise_url(target).starts_with("http://"),
                "{target} became {}",
                normalise_url(target)
            );
        }
    }

    #[test]
    fn an_explicit_scheme_is_left_alone() {
        for target in [
            "https://example.com",
            "http://localhost:3000",
            "about:blank",
            "data:text/html,<p>hi</p>",
            "file:///tmp/page.html",
        ] {
            assert_eq!(normalise_url(target), target);
        }
    }

    /// Every verb has to appear in the help, or a user cannot discover it —
    /// checked against the parser rather than by eye, since the two drift.
    #[test]
    fn the_help_lists_every_verb() {
        // Each verb with a line that is actually valid for it — `type` takes
        // two arguments, so neither `type` nor `type x` is a fair probe.
        for (verb, example) in [
            ("goto", "goto example.com"),
            ("eval", "eval 1+1"),
            ("click", "click #a"),
            ("type", "type #a b"),
            ("wait", "wait #a"),
            ("text", "text"),
            ("title", "title"),
            ("url", "url"),
            ("shot", "shot"),
            ("back", "back"),
            ("reload", "reload"),
            ("help", "help"),
        ] {
            assert!(HELP.contains(verb), "`{verb}` is missing from HELP");
            assert!(parse(example).is_ok(), "`{example}` does not parse");
        }
    }
}
