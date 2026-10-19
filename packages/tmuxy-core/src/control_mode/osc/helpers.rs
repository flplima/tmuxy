use super::OscOutput;

/// Parse Kitty OSC 66 text-sizing sequence (`66 ; metadata ; text`) and append
/// its text payload to `out.bytes`, recording any scaled cell range in `out.sized`.
pub(super) fn emit_osc66(rest: &[u8], out: &mut OscOutput) {
    let Some(semi) = rest.iter().position(|&b| b == b';') else {
        return;
    };
    let meta = std::str::from_utf8(&rest[..semi]).unwrap_or("");
    let text = &rest[semi + 1..];
    if text.is_empty() {
        return;
    }

    let mut scale: u8 = 1;
    let mut width: u8 = 0;
    for part in meta.split(':') {
        if let Some(v) = part.strip_prefix("s=") {
            scale = v.parse::<u8>().unwrap_or(1);
        } else if let Some(v) = part.strip_prefix("w=") {
            width = v.parse::<u8>().unwrap_or(0);
        }
    }

    let start = out.bytes.len();
    out.bytes.extend_from_slice(text);
    let end = out.bytes.len();

    if scale >= 2 {
        out.sized
            .push((start, end, crate::CellSize::DoubleHeightTop, true));
    } else if width >= 2 {
        out.sized
            .push((start, end, crate::CellSize::DoubleWidth, false));
    }
}

/// Simple base64 decoder (standard alphabet)
pub(super) fn base64_decode(input: &str) -> Result<Vec<u8>, &'static str> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut output = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for c in input.bytes() {
        if c == b'=' {
            // Padding
            break;
        }
        if c == b'\n' || c == b'\r' || c == b' ' {
            // Skip whitespace
            continue;
        }

        let value = match ALPHABET.iter().position(|&x| x == c) {
            Some(v) => v as u32,
            None => return Err("Invalid base64 character"),
        };

        buffer = (buffer << 6) | value;
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(output)
}
