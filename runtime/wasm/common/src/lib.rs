//! What the runner and the data service share: the pass, the twin database's
//! name and password, the frames between them, and log lines.

pub mod frame;
pub mod log;
pub mod pass;

use ring::hmac;

/// The password of a twin database's owner login (`<db>_owner`):
/// `hex(HMAC-SHA256(WASM_DB_SECRET, db))`. The platform sets it when it
/// clones the database; the data service derives it again when it connects.
pub fn db_password(secret: &str, db: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hex(hmac::sign(&key, db.as_bytes()).as_ref())
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// SHA-256 of `bytes`, in lowercase hex: a module's name.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

/// Whether `db` names a twin database: `^app_[a-z0-9_]+_staging_s[0-9]+_[0-9a-f]{6}_w$`
/// (the platform's `TWIN_DB_RE`, src/services/wasm-previews.js). Matched
/// from the right, which leaves exactly one way to read each part.
pub fn is_twin_db(db: &str) -> bool {
    let Some(rest) = db.strip_suffix("_w") else { return false };
    if rest.len() < 7 {
        return false;
    }
    let (rest, hex6) = rest.split_at(rest.len() - 6);
    if !hex6.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return false;
    }
    let Some(rest) = rest.strip_suffix('_') else { return false };
    let digits = rest.bytes().rev().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let rest = &rest[..rest.len() - digits];
    let Some(rest) = rest.strip_suffix("_staging_s") else { return false };
    let Some(middle) = rest.strip_prefix("app_") else { return false };
    !middle.is_empty() && middle.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_is_hmac_sha256_hex() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
        assert_eq!(
            db_password("Jefe", "what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(db_password("s", "app_x_staging_s1_abcdef_w").len(), 64);
    }

    #[test]
    fn twin_database_names() {
        for ok in [
            "app_grocery_staging_s101_abc123_w",
            "app_my_app_2_staging_s9_000000_w",
            "app_x_staging_s12345_ffffff_w",
            "app_a_staging_s1_staging_s2_abcdef_w",
        ] {
            assert!(is_twin_db(ok), "{ok}");
        }
        for bad in [
            "",
            "app_grocery",
            "app_grocery_w",
            "app__staging_s1_abcdef_w",
            "app_Grocery_staging_s1_abcdef_w",
            "app_grocery_staging_s1_abcdeg_w",
            "app_grocery_staging_s1_abcde_w",
            "app_grocery_staging_s_abcdef_w",
            "app_grocery_staging_sx1_abcdef_w",
            "app_grocery_staging_s1_abcdef",
            "app_grocery_staging_s1_abcdef_w_",
            "postgres",
            "app_grocery_staging_s1_ABCDEF_w",
            "app-grocery_staging_s1_abcdef_w",
            "xapp_grocery_staging_s1_abcdef_w",
            "app_grocery;drop_staging_s1_abcdef_w",
        ] {
            assert!(!is_twin_db(bad), "{bad}");
        }
    }

    #[test]
    fn sha256() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
