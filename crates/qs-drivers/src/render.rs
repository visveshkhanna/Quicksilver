//! Rendering values the server sends as binary into the text the grid shows.

/// Binary data as `\x` followed by lowercase hex, the way Postgres prints
/// `bytea`, so every engine shows bytes the same way.
pub(crate) fn hex_bytes(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("\\x");
    for &b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

/// A float the way SQL engines print it: shortest round-trip digits, and
/// `NaN`, `Infinity` and `-Infinity` spelled out.
pub(crate) fn float(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_render_as_postgres_hex() {
        assert_eq!(hex_bytes(&[0xde, 0xad, 0x00, 0x0f]), "\\xdead000f");
        assert_eq!(hex_bytes(&[]), "\\x");
    }

    #[test]
    fn floats_round_trip_and_spell_specials() {
        assert_eq!(float(0.1), "0.1");
        assert_eq!(float(-2.5), "-2.5");
        assert_eq!(float(f64::NAN), "NaN");
        assert_eq!(float(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(float(1e300).parse::<f64>().expect("parses"), 1e300);
    }
}
