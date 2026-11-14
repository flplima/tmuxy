//! Values written as TypeScript literals, the way prettier prints them, for
//! the generated UI module.

use super::quoted;

/// A number as TypeScript writes it after prettier: `1`, not `1.0`.
pub fn ts_number(value: &serde_json::Number) -> String {
    value
        .as_f64()
        .map_or_else(|| value.to_string(), |v| format!("{v}"))
}

/// A JSON value as a TypeScript literal, keys in sorted order and indented
/// the way prettier prints it (objects only nest one level here).
pub fn ts_literal(value: &serde_json::Value, indent: &str) -> String {
    match value {
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => ts_number(n),
        serde_json::Value::String(s) => quoted(s),
        serde_json::Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| ts_literal(v, indent))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        serde_json::Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            if indent.is_empty() {
                let inner = "  ";
                let body: String = keys
                    .iter()
                    .map(|k| format!("{inner}{k}: {},\n", ts_literal(&map[*k], inner)))
                    .collect();
                format!("{{\n{body}}}")
            } else {
                let body = keys
                    .iter()
                    .map(|k| format!("{k}: {}", ts_literal(&map[*k], indent)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{{ {body} }}")
            }
        }
        serde_json::Value::Null => "null".to_string(),
    }
}

/// A character as a TypeScript string literal, quoted the way prettier quotes it.
pub fn ts_char(c: char) -> String {
    match c {
        '\'' => "\"'\"".to_string(),
        '\\' => "'\\\\'".to_string(),
        c => format!("'{c}'"),
    }
}
