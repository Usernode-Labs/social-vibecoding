//! Structured logs: one JSON object per line on stderr, with a UTC time.

use serde_json::{Map, Value};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// `2026-11-27T14:55:01.123Z`
pub fn utc_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// Writes `{"t":…,"lvl":…,"msg":…, ...fields}` as one line.
pub fn line(level: &str, msg: &str, fields: Value) {
    let mut m = Map::new();
    m.insert("t".into(), Value::String(utc_now()));
    m.insert("lvl".into(), Value::String(level.into()));
    m.insert("msg".into(), Value::String(msg.into()));
    if let Value::Object(f) = fields {
        for (k, v) in f {
            m.insert(k, v);
        }
    }
    let mut s = Value::Object(m).to_string();
    s.push('\n');
    let _ = std::io::stderr().lock().write_all(s.as_bytes());
}

pub fn info(msg: &str, fields: Value) {
    line("info", msg, fields)
}
pub fn warn(msg: &str, fields: Value) {
    line("warn", msg, fields)
}
pub fn error(msg: &str, fields: Value) {
    line("error", msg, fields)
}

#[cfg(test)]
mod tests {
    #[test]
    fn time_shape() {
        let t = super::utc_now();
        assert_eq!(t.len(), 24);
        assert!(t.ends_with('Z') && &t[4..5] == "-" && &t[10..11] == "T");
    }
}
