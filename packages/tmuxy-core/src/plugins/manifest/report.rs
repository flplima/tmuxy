//! What `tmuxy plugin check` prints: a manifest's problems, each with the
//! line it is on.

/// One problem with a manifest, with the line it is on when known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub message: String,
}

impl Diagnostic {
    /// `path:line:col: message`, as a compiler prints it.
    pub fn render(&self, path: &str) -> String {
        match (self.line, self.column) {
            (Some(line), Some(col)) => format!("{path}:{line}:{col}: {}", self.message),
            (Some(line), None) => format!("{path}:{line}: {}", self.message),
            _ => format!("{path}: {}", self.message),
        }
    }
}

/// Collects diagnostics, turning byte spans into lines.
pub(super) struct Report<'a> {
    pub(super) text: &'a str,
    pub(super) diagnostics: Vec<Diagnostic>,
}

impl Report<'_> {
    pub(super) fn at(&mut self, span: std::ops::Range<usize>, message: impl Into<String>) {
        let (line, column) = line_col(self.text, span.start);
        self.diagnostics.push(Diagnostic {
            line: Some(line),
            column: Some(column),
            message: message.into(),
        });
    }
}

/// 1-based line and column of a byte offset.
pub(super) fn line_col(text: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(text.len());
    let before = &text[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rfind('\n')
        .map(|nl| before[nl + 1..].chars().count())
        .unwrap_or_else(|| before.chars().count())
        + 1;
    (line, column)
}
