//! Octal escape sequence decoder for tmux control mode
//!
//! Tmux control mode escapes non-printable characters (< 32) and backslash as octal sequences.
//! For example: `\033` -> ESC (0x1b), `\134` -> backslash (0x5c)

/// Decode octal escape sequences from control mode output.
///
/// Characters with ASCII values below 32 and backslash (`\`) are escaped as `\xxx`
/// where `xxx` is a three-digit octal number.
///
/// # Examples
/// ```
/// use tmuxy_core::control_mode::decode_octal;
///
/// // Decode ESC sequence
/// assert_eq!(decode_octal(r"\033[0m"), vec![0x1b, b'[', b'0', b'm']);
///
/// // Decode backslash
/// assert_eq!(decode_octal(r"\134"), vec![b'\\']);
///
/// // Mixed content
/// assert_eq!(decode_octal(r"Hello\033[1mWorld"), b"Hello\x1b[1mWorld".to_vec());
/// ```
pub fn decode_octal(input: &str) -> Vec<u8> {
    let mut result = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            // Check if next 3 characters are octal digits (0-7)
            let d1 = bytes[i + 1];
            let d2 = bytes[i + 2];
            let d3 = bytes[i + 3];

            if is_octal_digit(d1) && is_octal_digit(d2) && is_octal_digit(d3) {
                // Parse octal value
                let value =
                    ((d1 - b'0') as u16 * 64) + ((d2 - b'0') as u16 * 8) + ((d3 - b'0') as u16);

                if value <= 255 {
                    result.push(value as u8);
                    i += 4;
                    continue;
                }
            }
        }

        // Not an octal escape, copy byte as-is
        result.push(bytes[i]);
        i += 1;
    }

    result
}

#[inline]
fn is_octal_digit(b: u8) -> bool {
    (b'0'..=b'7').contains(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_esc() {
        // ESC = 033 octal = 0x1b
        assert_eq!(decode_octal(r"\033"), vec![0x1b]);
        assert_eq!(decode_octal(r"\033[0m"), vec![0x1b, b'[', b'0', b'm']);
    }

    #[test]
    fn test_decode_backslash() {
        // Backslash = 134 octal = 0x5c
        assert_eq!(decode_octal(r"\134"), vec![b'\\']);
    }

    #[test]
    fn test_decode_newline() {
        // Newline = 012 octal = 0x0a
        assert_eq!(decode_octal(r"\012"), vec![0x0a]);
    }

    #[test]
    fn test_decode_carriage_return() {
        // CR = 015 octal = 0x0d
        assert_eq!(decode_octal(r"\015"), vec![0x0d]);
    }

    #[test]
    fn test_decode_tab() {
        // Tab = 011 octal = 0x09
        assert_eq!(decode_octal(r"\011"), vec![0x09]);
    }

    #[test]
    fn test_decode_mixed() {
        let input = r"Hello\033[1mWorld\033[0m";
        let expected = b"Hello\x1b[1mWorld\x1b[0m";
        assert_eq!(decode_octal(input), expected.to_vec());
    }

    #[test]
    fn test_decode_no_escapes() {
        assert_eq!(decode_octal("Hello World"), b"Hello World".to_vec());
    }

    #[test]
    fn test_decode_incomplete_escape() {
        // Not enough digits after backslash
        assert_eq!(decode_octal(r"\03"), b"\\03".to_vec());
        assert_eq!(decode_octal(r"\0"), b"\\0".to_vec());
        assert_eq!(decode_octal(r"\"), b"\\".to_vec());
    }

    #[test]
    fn test_decode_invalid_octal_digits() {
        // 8 and 9 are not octal digits
        assert_eq!(decode_octal(r"\089"), b"\\089".to_vec());
        assert_eq!(decode_octal(r"\999"), b"\\999".to_vec());
    }

    #[test]
    fn test_decode_bell() {
        // BEL = 007 octal = 0x07
        assert_eq!(decode_octal(r"\007"), vec![0x07]);
    }

    #[test]
    fn test_decode_osc_sequence() {
        // OSC 8 hyperlink: \033]8;;url\033\\text\033]8;;\033\\
        let input = r"\033]8;;https://example.com\033\134Link\033]8;;\033\134";
        let decoded = decode_octal(input);
        // Should contain ESC ] 8 ; ; url ESC \ Link ESC ] 8 ; ; ESC \
        assert_eq!(decoded[0], 0x1b); // ESC
        assert_eq!(decoded[1], b']');
        assert_eq!(decoded[2], b'8');
    }
}
