//! The pass (version 1): `base64url(JSON) "." base64url(Ed25519 signature over
//! the first part)`, signed by the platform with WASM_PASS_KEY and checked
//! here with WASM_PASS_PUBKEY (the raw 32-byte public key, base64).

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ring::signature::{self, Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// What a pass says. `user` is null for a guest. `env` is optional: extra
/// environment the app sees (USERNODE_APP_NAME, USERNODE_APP_SLUG, …).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pass {
    pub v: u32,
    pub app: u64,
    pub ses: u64,
    #[serde(rename = "mod")]
    pub module: String,
    pub db: String,
    #[serde(default)]
    pub user: Option<i64>,
    pub scope: Scope,
    pub exp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// One request (the platform signs it for 60 s).
    Req,
    /// The release's setup run (300 s).
    Setup,
}

/// Why a pass was refused, worded for a 502 body or a log line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassError {
    Missing,
    Malformed,
    BadSignature,
    Expired,
    Unsupported(String),
}

impl std::fmt::Display for PassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PassError::Missing => write!(f, "no pass"),
            PassError::Malformed => write!(f, "malformed pass"),
            PassError::BadSignature => write!(f, "bad pass signature"),
            PassError::Expired => write!(f, "pass expired"),
            PassError::Unsupported(why) => write!(f, "pass refused: {why}"),
        }
    }
}
impl std::error::Error for PassError {}

pub fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Base64 as people write it: standard or URL-safe, padded or not.
pub fn decode_b64(s: &str) -> Result<Vec<u8>> {
    let t = s.trim();
    STANDARD
        .decode(t)
        .or_else(|_| URL_SAFE.decode(t))
        .or_else(|_| URL_SAFE_NO_PAD.decode(t.trim_end_matches('=')))
        .map_err(|_| anyhow!("not base64"))
}

/// The public half that checks passes.
#[derive(Clone)]
pub struct PassKey {
    public: Vec<u8>,
}

impl PassKey {
    /// From WASM_PASS_PUBKEY: the raw 32-byte Ed25519 public key in base64.
    pub fn from_base64(s: &str) -> Result<Self> {
        let public = decode_b64(s).context("WASM_PASS_PUBKEY is not base64")?;
        if public.len() != 32 {
            bail!("WASM_PASS_PUBKEY must be 32 bytes (raw Ed25519 public key), got {}", public.len());
        }
        Ok(PassKey { public })
    }

    /// Checks the signature, the version, the expiry and the shape of the
    /// fields every holder relies on (the module's hash).
    pub fn verify(&self, pass: &str, now: u64) -> Result<Pass, PassError> {
        let pass = pass.trim();
        if pass.is_empty() {
            return Err(PassError::Missing);
        }
        let (body, sig) = pass.split_once('.').ok_or(PassError::Malformed)?;
        let sig = URL_SAFE_NO_PAD.decode(sig.trim_end_matches('=')).map_err(|_| PassError::Malformed)?;
        signature::UnparsedPublicKey::new(&signature::ED25519, &self.public)
            .verify(body.as_bytes(), &sig)
            .map_err(|_| PassError::BadSignature)?;
        let json = URL_SAFE_NO_PAD.decode(body.trim_end_matches('=')).map_err(|_| PassError::Malformed)?;
        let p: Pass = serde_json::from_slice(&json).map_err(|_| PassError::Malformed)?;
        if p.v != 1 {
            return Err(PassError::Unsupported(format!("version {}", p.v)));
        }
        if p.exp < now {
            return Err(PassError::Expired);
        }
        if p.module.len() != 64 || !p.module.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(PassError::Unsupported("mod is not a lowercase sha256 hex".into()));
        }
        Ok(p)
    }
}

/// Signs a pass with a PKCS#8 Ed25519 key (WASM_PASS_KEY's format; v1 or
/// v2 PKCS#8). The platform signs its own; this is for tests and tools.
pub fn sign(pkcs8: &[u8], pass: &Pass) -> Result<String> {
    let key = Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8).map_err(|e| anyhow!("bad PKCS#8 Ed25519 key: {e}"))?;
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(pass)?);
    let sig = key.sign(body.as_bytes());
    Ok(format!("{body}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref())))
}

/// A fresh key pair: (PKCS#8 v2, raw public key). For tests.
pub fn generate() -> Result<(Vec<u8>, Vec<u8>)> {
    let rng = ring::rand::SystemRandom::new();
    let pk8 = Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| anyhow!("keygen failed"))?;
    let kp = Ed25519KeyPair::from_pkcs8(pk8.as_ref()).map_err(|_| anyhow!("keygen failed"))?;
    Ok((pk8.as_ref().to_vec(), kp.public_key().as_ref().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(exp: u64) -> Pass {
        Pass {
            v: 1,
            app: 123,
            ses: 456,
            module: "a".repeat(64),
            db: "app_slug_staging_s456_ab12cd_w".into(),
            user: Some(789),
            scope: Scope::Req,
            exp,
            env: None,
        }
    }

    #[test]
    fn round_trip_and_refusals() {
        let (pk8, public) = generate().unwrap();
        let key = PassKey::from_base64(&STANDARD.encode(&public)).unwrap();
        let now = 1_800_000_000;
        let token = sign(&pk8, &sample(now + 60)).unwrap();
        assert_eq!(key.verify(&token, now).unwrap(), sample(now + 60));

        // Expired.
        assert_eq!(key.verify(&token, now + 61), Err(PassError::Expired));
        // An edited body keeps the old signature.
        let (body, sig) = token.split_once('.').unwrap();
        let mut forged = sample(now + 60);
        forged.app = 124;
        let forged_body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        assert_eq!(key.verify(&format!("{forged_body}.{sig}"), now), Err(PassError::BadSignature));
        // Another key's signature.
        let (other, _) = generate().unwrap();
        assert_eq!(key.verify(&sign(&other, &sample(now + 60)).unwrap(), now), Err(PassError::BadSignature));
        // Not a pass at all.
        assert_eq!(key.verify("", now), Err(PassError::Missing));
        assert_eq!(key.verify("abc", now), Err(PassError::Malformed));
        assert_eq!(key.verify(&format!("{body}.!!"), now), Err(PassError::Malformed));
    }

    #[test]
    fn fields_and_versions() {
        let (pk8, public) = generate().unwrap();
        let key = PassKey::from_base64(&URL_SAFE_NO_PAD.encode(&public)).unwrap();
        let now = 1_800_000_000;
        let mut p = sample(now + 60);
        p.v = 2;
        assert!(matches!(key.verify(&sign(&pk8, &p).unwrap(), now), Err(PassError::Unsupported(_))));
        let mut p = sample(now + 60);
        p.module = "A".repeat(64);
        assert!(matches!(key.verify(&sign(&pk8, &p).unwrap(), now), Err(PassError::Unsupported(_))));
        // The platform's own shape: user null, setup scope, env.
        let json = format!(
            r#"{{"v":1,"app":1,"ses":2,"mod":"{}","db":"app_x_staging_s2_abcdef_w","user":null,"scope":"setup","exp":{},"env":{{"USERNODE_APP_NAME":"X"}}}}"#,
            "0".repeat(64),
            now + 300
        );
        let body = URL_SAFE_NO_PAD.encode(json.as_bytes());
        let kp = Ed25519KeyPair::from_pkcs8(&pk8).unwrap();
        let token = format!("{body}.{}", URL_SAFE_NO_PAD.encode(kp.sign(body.as_bytes()).as_ref()));
        let got = key.verify(&token, now).unwrap();
        assert_eq!(got.scope, Scope::Setup);
        assert_eq!(got.user, None);
        assert_eq!(got.env.unwrap()["USERNODE_APP_NAME"], "X");
    }

    #[test]
    fn public_key_shapes() {
        assert!(PassKey::from_base64("AAAA").is_err());
        assert!(PassKey::from_base64("not base64 at all!").is_err());
    }
}
