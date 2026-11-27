//! Homeroom's identity tokens: RS256 for a person (USERNODE_JWT_PUBLIC_KEY),
//! ES256 for a guest (USERNODE_GUEST_JWT_PUBLIC_KEY, optional).

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde_json::Value;

pub struct Identity {
    user: Option<DecodingKey>,
    guest: Option<DecodingKey>,
    /// The PEMs, handed to the app as its environment says they would be.
    pub user_pem: Option<String>,
    pub guest_pem: Option<String>,
}

impl Identity {
    pub fn new(user_pem: Option<String>, guest_pem: Option<String>) -> anyhow::Result<Self> {
        let user = match &user_pem {
            Some(p) => Some(DecodingKey::from_rsa_pem(p.as_bytes()).map_err(|e| anyhow::anyhow!("USERNODE_JWT_PUBLIC_KEY: {e}"))?),
            None => None,
        };
        let guest = match &guest_pem {
            Some(p) => Some(DecodingKey::from_ec_pem(p.as_bytes()).map_err(|e| anyhow::anyhow!("USERNODE_GUEST_JWT_PUBLIC_KEY: {e}"))?),
            None => None,
        };
        Ok(Identity { user, guest, user_pem, guest_pem })
    }

    /// The request's identity: a person's token for this app, checked in
    /// full (signature, issuer `usernode`, audience `usernode:app:<app>`,
    /// expiry). None for anything else.
    pub fn check_request(&self, token: &str, app: u64) -> Option<Value> {
        let key = self.user.as_ref()?;
        let mut v = Validation::new(Algorithm::RS256);
        v.set_issuer(&["usernode"]);
        v.set_audience(&[format!("usernode:app:{app}")]);
        v.leeway = 0;
        v.validate_nbf = true;
        decode::<Value>(token, key, &v).ok().map(|d| d.claims)
    }

    /// The signature alone, for the app's own jsonwebtoken.verify (which
    /// then checks the claims itself, as jsonwebtoken does): (claims, alg).
    pub fn verify_signature(&self, token: &str) -> Result<(Value, &'static str), String> {
        let header = decode_header(token).map_err(|_| "jwt malformed".to_string())?;
        let (key, alg, name) = match header.alg {
            Algorithm::RS256 => (self.user.as_ref(), Algorithm::RS256, "RS256"),
            Algorithm::ES256 => (self.guest.as_ref(), Algorithm::ES256, "ES256"),
            _ => return Err("invalid algorithm".into()),
        };
        let key = key.ok_or_else(|| "secret or public key must be provided".to_string())?;
        let mut v = Validation::new(alg);
        v.validate_exp = false;
        v.validate_nbf = false;
        v.validate_aud = false;
        v.required_spec_claims.clear();
        v.leeway = 0;
        decode::<Value>(token, key, &v).map(|d| (d.claims, name)).map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::InvalidSignature => "invalid signature".to_string(),
            _ => "invalid token".to_string(),
        })
    }
}
