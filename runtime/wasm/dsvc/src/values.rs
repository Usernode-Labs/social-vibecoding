//! A result as JSON: `{"f":[names],"t":[type oids],"n":rows affected,"cmd":…,"rows":[[…]]}`.
//!
//! Postgres sends each value in binary; it is written here as the JSON value
//! closest to what node-pg gives an app, and the guest's pg adapter finishes
//! the rest by type (a Date, a Buffer). int8, numeric and money stay strings
//! (node-pg's default); timestamps go as epoch milliseconds; dates, times,
//! uuids, inet and the like as their usual text; json and jsonb as the JSON
//! they hold; bytea as base64; arrays as arrays; an interval as the object
//! node-pg's postgres-interval makes.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use fallible_iterator::FallibleIterator;
use postgres_protocol::types as pt;
use std::fmt::Write;
use tokio_postgres::types::{FromSql, Kind, Type};
use tokio_postgres::Row;

/// The raw bytes of one value, whatever its type.
pub struct Raw<'a>(pub Option<&'a [u8]>);
impl<'a> FromSql<'a> for Raw<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Raw(Some(raw)))
    }
    fn from_sql_null(_: &Type) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(Raw(None))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

/// The type the guest is told about: a domain is its base type.
pub fn effective(t: &Type) -> &Type {
    match t.kind() {
        Kind::Domain(base) => effective(base),
        _ => t,
    }
}

const PG_EPOCH_MS: i64 = 946_684_800_000;
const PG_EPOCH_DAYS: i64 = 10_957; // 1970-01-01 to 2000-01-01

fn json_str(o: &mut String, s: &str) {
    o.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()));
}

fn civil(days_since_1970: i64) -> (i64, u32, u32) {
    let z = days_since_1970 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn date_text(days_since_2000: i32) -> String {
    match days_since_2000 {
        i32::MAX => "infinity".into(),
        i32::MIN => "-infinity".into(),
        d => {
            let (y, m, dd) = civil(d as i64 + PG_EPOCH_DAYS);
            if y <= 0 {
                format!("{:04}-{m:02}-{dd:02} BC", 1 - y)
            } else {
                format!("{y:04}-{m:02}-{dd:02}")
            }
        }
    }
}

fn time_text(us: i64) -> String {
    let (s, frac) = (us.div_euclid(1_000_000), us.rem_euclid(1_000_000));
    let mut t = format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60);
    if frac != 0 {
        let f = format!("{frac:06}");
        t.push('.');
        t.push_str(f.trim_end_matches('0'));
    }
    t
}

fn tz_text(west_secs: i32) -> String {
    let east = -west_secs;
    let sign = if east < 0 { '-' } else { '+' };
    let a = east.abs();
    let (h, m, s) = (a / 3600, (a / 60) % 60, a % 60);
    if s != 0 {
        format!("{sign}{h:02}:{m:02}:{s:02}")
    } else if m != 0 {
        format!("{sign}{h:02}:{m:02}")
    } else {
        format!("{sign}{h:02}")
    }
}

/// Postgres's binary numeric as its text form.
fn numeric_text(b: &[u8]) -> Option<String> {
    if b.len() < 8 {
        return None;
    }
    let rd = |i: usize| u16::from_be_bytes([b[i], b[i + 1]]);
    let ndigits = rd(0) as usize;
    let weight = rd(2) as i16 as i32;
    let sign = rd(4);
    let dscale = rd(6) as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => {}
    }
    if b.len() < 8 + ndigits * 2 {
        return None;
    }
    let digits: Vec<u16> = (0..ndigits).map(|i| rd(8 + i * 2)).collect();
    let mut s = String::new();
    if sign == 0x4000 {
        s.push('-');
    }
    // Integer part: groups for weights weight..=0.
    if weight < 0 {
        s.push('0');
    } else {
        for w in 0..=weight {
            let d = digits.get(w as usize).copied().unwrap_or(0);
            if w == 0 {
                let _ = write!(s, "{d}");
            } else {
                let _ = write!(s, "{d:04}");
            }
        }
    }
    if dscale > 0 {
        s.push('.');
        let mut frac = String::new();
        let mut i = weight + 1;
        while frac.len() < dscale {
            let d = if i < 0 { 0 } else { digits.get(i as usize).copied().unwrap_or(0) };
            let _ = write!(frac, "{d:04}");
            i += 1;
        }
        frac.truncate(dscale);
        s.push_str(&frac);
    }
    Some(s)
}

fn interval_json(o: &mut String, b: &[u8]) -> Option<()> {
    if b.len() != 16 {
        return None;
    }
    let us = i64::from_be_bytes(b[0..8].try_into().ok()?);
    let days = i32::from_be_bytes(b[8..12].try_into().ok()?);
    let months = i32::from_be_bytes(b[12..16].try_into().ok()?);
    let mut parts: Vec<(&str, f64)> = vec![];
    if months / 12 != 0 {
        parts.push(("years", (months / 12) as f64));
    }
    if months % 12 != 0 {
        parts.push(("months", (months % 12) as f64));
    }
    if days != 0 {
        parts.push(("days", days as f64));
    }
    let neg = us < 0;
    let a = us.unsigned_abs();
    let sign = if neg { -1.0 } else { 1.0 };
    let (h, m, s, ms) = (a / 3_600_000_000, (a / 60_000_000) % 60, (a / 1_000_000) % 60, (a % 1_000_000) as f64 / 1000.0);
    if h != 0 {
        parts.push(("hours", sign * h as f64));
    }
    if m != 0 {
        parts.push(("minutes", sign * m as f64));
    }
    if s != 0 {
        parts.push(("seconds", sign * s as f64));
    }
    if ms != 0.0 {
        parts.push(("milliseconds", sign * ms));
    }
    o.push('{');
    for (i, (k, v)) in parts.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        let _ = write!(o, "\"{k}\":{v}");
    }
    o.push('}');
    Some(())
}

fn inet_text(b: &[u8]) -> Option<String> {
    if b.len() < 4 {
        return None;
    }
    let (family, bits, is_cidr, n) = (b[0], b[1], b[2], b[3] as usize);
    let addr = b.get(4..4 + n)?;
    let (text, full) = if family == 2 && n == 4 {
        (std::net::Ipv4Addr::new(addr[0], addr[1], addr[2], addr[3]).to_string(), 32)
    } else if n == 16 {
        let a: [u8; 16] = addr.try_into().ok()?;
        (std::net::Ipv6Addr::from(a).to_string(), 128)
    } else {
        return None;
    };
    Some(if is_cidr != 0 || bits != full { format!("{text}/{bits}") } else { text })
}

fn float(o: &mut String, v: f64) {
    if v.is_finite() {
        let _ = write!(o, "{}", serde_json::Number::from_f64(v).map(|n| n.to_string()).unwrap_or_else(|| "0".into()));
    } else if v.is_nan() {
        o.push_str("\"NaN\"");
    } else if v > 0.0 {
        o.push_str("\"Infinity\"");
    } else {
        o.push_str("\"-Infinity\"");
    }
}

fn fallback(o: &mut String, b: &[u8]) {
    match std::str::from_utf8(b) {
        Ok(s) => json_str(o, s),
        Err(_) => json_str(o, &STANDARD.encode(b)),
    }
}

/// Writes one value of type `t` as JSON.
pub fn value(o: &mut String, t: &Type, b: Option<&[u8]>) {
    let Some(b) = b else {
        o.push_str("null");
        return;
    };
    let t = effective(t);
    if let Kind::Array(elem) = t.kind() {
        if array(o, elem, b).is_none() {
            o.push_str("null");
        }
        return;
    }
    let ok = match *t {
        Type::BOOL => {
            o.push_str(if b.first() == Some(&1) { "true" } else { "false" });
            true
        }
        Type::INT2 => pt::int2_from_sql(b).map(|v| write!(o, "{v}").is_ok()).unwrap_or(false),
        Type::INT4 => pt::int4_from_sql(b).map(|v| write!(o, "{v}").is_ok()).unwrap_or(false),
        Type::OID => pt::oid_from_sql(b).map(|v| write!(o, "{v}").is_ok()).unwrap_or(false),
        Type::INT8 => pt::int8_from_sql(b).map(|v| write!(o, "\"{v}\"").is_ok()).unwrap_or(false),
        Type::FLOAT4 => pt::float4_from_sql(b).map(|v| float(o, v as f64)).is_ok(),
        Type::FLOAT8 => pt::float8_from_sql(b).map(|v| float(o, v)).is_ok(),
        Type::NUMERIC => numeric_text(b).map(|s| json_str(o, &s)).is_some(),
        Type::MONEY => pt::int8_from_sql(b)
            .map(|c| {
                let sign = if c < 0 { "-" } else { "" };
                let a = c.unsigned_abs();
                json_str(o, &format!("{sign}${}.{:02}", a / 100, a % 100));
            })
            .is_ok(),
        Type::JSON => std::str::from_utf8(b).map(|s| o.push_str(s)).is_ok(),
        Type::JSONB => b.split_first().filter(|(v, _)| **v == 1).and_then(|(_, rest)| std::str::from_utf8(rest).ok()).map(|s| o.push_str(s)).is_some(),
        Type::BYTEA => {
            json_str(o, &STANDARD.encode(b));
            true
        }
        Type::TIMESTAMP | Type::TIMESTAMPTZ => pt::timestamp_from_sql(b)
            .map(|us| match us {
                i64::MAX => o.push_str("\"infinity\""),
                i64::MIN => o.push_str("\"-infinity\""),
                us => {
                    let _ = write!(o, "{}", us.div_euclid(1000) + PG_EPOCH_MS);
                }
            })
            .is_ok(),
        Type::DATE => pt::date_from_sql(b).map(|d| json_str(o, &date_text(d))).is_ok(),
        Type::TIME => pt::time_from_sql(b).map(|us| json_str(o, &time_text(us))).is_ok(),
        Type::TIMETZ if b.len() == 12 => {
            let us = i64::from_be_bytes(b[0..8].try_into().unwrap());
            let tz = i32::from_be_bytes(b[8..12].try_into().unwrap());
            json_str(o, &format!("{}{}", time_text(us), tz_text(tz)));
            true
        }
        Type::INTERVAL => interval_json(o, b).is_some(),
        Type::UUID => pt::uuid_from_sql(b)
            .map(|u| {
                let h = wasm_common::hex(&u);
                json_str(o, &format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]));
            })
            .is_ok(),
        Type::INET | Type::CIDR => inet_text(b).map(|s| json_str(o, &s)).is_some(),
        Type::MACADDR if b.len() == 6 => {
            json_str(o, &b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":"));
            true
        }
        Type::CHAR if b.len() == 1 => {
            json_str(o, &(b[0] as char).to_string());
            true
        }
        Type::VOID => {
            o.push_str("\"\"");
            true
        }
        _ => {
            // Text-like types (text, varchar, bpchar, name, xml, citext, an
            // enum's label) are their UTF-8 bytes in binary too.
            fallback(o, b);
            true
        }
    };
    if !ok {
        o.push_str("null");
    }
}

fn array(o: &mut String, elem: &Type, b: &[u8]) -> Option<()> {
    let arr = pt::array_from_sql(b).ok()?;
    let dims: Vec<i32> = arr.dimensions().map(|d| Ok(d.len)).collect().ok()?;
    let values: Vec<Option<&[u8]>> = arr.values().collect().ok()?;
    if dims.is_empty() {
        o.push_str("[]");
        return Some(());
    }
    let mut i = 0usize;
    nest(o, elem, &dims, &values, &mut i);
    Some(())
}

fn nest(o: &mut String, elem: &Type, dims: &[i32], values: &[Option<&[u8]>], i: &mut usize) {
    o.push('[');
    for k in 0..dims[0].max(0) {
        if k > 0 {
            o.push(',');
        }
        if dims.len() > 1 {
            nest(o, elem, &dims[1..], values, i);
        } else {
            value(o, elem, values.get(*i).copied().flatten());
            *i += 1;
        }
    }
    o.push(']');
}

/// One result: column names and types, the rows, the command and its count.
pub fn result_json(columns: &[tokio_postgres::Column], rows: &[Row], affected: Option<u64>, cmd: &str) -> String {
    let mut o = String::with_capacity(64 + rows.len() * 96);
    o.push_str("{\"f\":[");
    for (i, c) in columns.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        json_str(&mut o, c.name());
    }
    o.push_str("],\"t\":[");
    for (i, c) in columns.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        let _ = write!(o, "{}", effective(c.type_()).oid());
    }
    let n = if columns.is_empty() { affected.unwrap_or(0) } else { affected.unwrap_or(rows.len() as u64) };
    let _ = write!(o, "],\"n\":{n},\"cmd\":");
    json_str(&mut o, cmd);
    o.push_str(",\"rows\":[");
    for (ri, r) in rows.iter().enumerate() {
        if ri > 0 {
            o.push(',');
        }
        o.push('[');
        for (i, c) in columns.iter().enumerate() {
            if i > 0 {
                o.push(',');
            }
            let Raw(v) = r.get(i);
            value(&mut o, c.type_(), v);
        }
        o.push(']');
    }
    o.push_str("]}");
    o
}

/// A result of the simple protocol (several statements in one string): text values.
pub fn simple_json(names: &[String], rows: &[Vec<Option<String>>], affected: u64, cmd: &str) -> String {
    let mut o = String::from("{\"f\":[");
    for (i, n) in names.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        json_str(&mut o, n);
    }
    o.push_str("],\"t\":[");
    o.push_str(&vec!["25"; names.len()].join(","));
    let _ = write!(o, "],\"n\":{affected},\"cmd\":");
    json_str(&mut o, cmd);
    o.push_str(",\"rows\":[");
    for (ri, r) in rows.iter().enumerate() {
        if ri > 0 {
            o.push(',');
        }
        o.push('[');
        for (i, v) in r.iter().enumerate() {
            if i > 0 {
                o.push(',');
            }
            match v {
                Some(s) => json_str(&mut o, s),
                None => o.push_str("null"),
            }
        }
        o.push(']');
    }
    o.push_str("]}");
    o
}

/// The command a statement runs ("SELECT", "INSERT", …), as node-pg's result.command.
pub fn command_of(sql: &str) -> String {
    let s = skip_comments(sql);
    let word: String = s.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    word.to_ascii_uppercase()
}

/// The statement after leading whitespace and SQL comments.
pub fn skip_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or("").trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.find("*/").map(|i| &rest[i + 2..]).unwrap_or("").trim_start();
        } else {
            return s;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numeric(ndigits: u16, weight: i16, sign: u16, dscale: u16, digits: &[u16]) -> Vec<u8> {
        let mut b = vec![];
        for v in [ndigits, weight as u16, sign, dscale] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        for d in digits {
            b.extend_from_slice(&d.to_be_bytes());
        }
        b
    }

    #[test]
    fn numerics() {
        assert_eq!(numeric_text(&numeric(2, 0, 0, 2, &[12, 3400])).unwrap(), "12.34");
        assert_eq!(numeric_text(&numeric(1, 1, 0, 0, &[1])).unwrap(), "10000");
        assert_eq!(numeric_text(&numeric(1, -1, 0x4000, 3, &[5000])).unwrap(), "-0.500");
        assert_eq!(numeric_text(&numeric(0, 0, 0, 0, &[])).unwrap(), "0");
        assert_eq!(numeric_text(&numeric(0, 0, 0, 2, &[])).unwrap(), "0.00");
        assert_eq!(numeric_text(&numeric(0, 0, 0xC000, 0, &[])).unwrap(), "NaN");
        assert_eq!(numeric_text(&numeric(3, 1, 0, 4, &[1, 2345, 6789])).unwrap(), "12345.6789");
        assert_eq!(numeric_text(&numeric(1, -2, 0, 6, &[1200])).unwrap(), "0.000012");
    }

    #[test]
    fn dates_and_times() {
        assert_eq!(date_text(0), "2000-01-01");
        assert_eq!(date_text(9827), "2026-11-27");
        assert_eq!(date_text(-1), "1999-12-31");
        assert_eq!(time_text(14 * 3_600_000_000 + 30 * 60_000_000), "14:30:00");
        assert_eq!(time_text(500_000), "00:00:00.5");
        assert_eq!(tz_text(-3600), "+01");
        assert_eq!(tz_text(19800), "-05:30");
    }

    #[test]
    fn intervals_and_inet() {
        let mut o = String::new();
        let mut b = vec![];
        b.extend_from_slice(&(90 * 60_000_000i64 + 1_500_000).to_be_bytes());
        b.extend_from_slice(&2i32.to_be_bytes());
        b.extend_from_slice(&14i32.to_be_bytes());
        interval_json(&mut o, &b).unwrap();
        assert_eq!(o, r#"{"years":1,"months":2,"days":2,"hours":1,"minutes":30,"seconds":1,"milliseconds":500}"#);
        assert_eq!(inet_text(&[2, 32, 0, 4, 10, 0, 0, 1]).unwrap(), "10.0.0.1");
        assert_eq!(inet_text(&[2, 24, 1, 4, 10, 0, 0, 0]).unwrap(), "10.0.0.0/24");
    }

    #[test]
    fn values_by_type() {
        let mut o = String::new();
        value(&mut o, &Type::INT8, Some(&42i64.to_be_bytes()));
        o.push(' ');
        value(&mut o, &Type::TIMESTAMPTZ, Some(&0i64.to_be_bytes()));
        o.push(' ');
        value(&mut o, &Type::JSONB, Some(b"\x01{\"a\":1}"));
        o.push(' ');
        value(&mut o, &Type::TEXT, Some("é\"".as_bytes()));
        o.push(' ');
        value(&mut o, &Type::FLOAT8, Some(&f64::NAN.to_be_bytes()));
        o.push(' ');
        value(&mut o, &Type::BOOL, None);
        assert_eq!(o, "\"42\" 946684800000 {\"a\":1} \"é\\\"\" \"NaN\" null");
    }

    #[test]
    fn commands() {
        assert_eq!(command_of("  -- hi\n/* x */ select 1"), "SELECT");
        assert_eq!(command_of("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"), "WITH");
    }
}
