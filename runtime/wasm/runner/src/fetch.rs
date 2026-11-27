//! An app's outside calls (fetch). Calls the app starts together run at the
//! same time here. Only http and https, and never to a private, loopback or
//! link-local address (the runner can reach the data service and the
//! platform's module endpoint; an app must not), unless
//! WASM_FETCH_ALLOW_PRIVATE=1 (tests). Addresses are checked after the DNS
//! lookup and on every redirect.

use anyhow::Result;
use bytes::Bytes;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::{Attempt, Policy};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

/// The most a response body may be.
const MAX_BODY: usize = 16 << 20;

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10, carrier NAT
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15
                || o[0] >= 240
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let s = v.segments();
            v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

struct PublicOnly;
impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| !is_private(a.ip())).collect();
            if addrs.is_empty() {
                return Err(format!("{host} has no public address").into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn literal_private(u: &reqwest::Url) -> bool {
    match u.host() {
        Some(url::Host::Ipv4(ip)) => is_private(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_private(IpAddr::V6(ip)),
        _ => false,
    }
}

#[derive(Deserialize)]
pub struct FetchCall {
    pub u: String,
    #[serde(default = "get")]
    pub m: String,
    #[serde(default)]
    pub h: Vec<(String, String)>,
    /// Time limit in ms (AbortSignal.timeout).
    #[serde(default)]
    pub t: Option<u64>,
    /// "follow", "manual" or "error".
    #[serde(default)]
    pub r: Option<String>,
}
fn get() -> String {
    "GET".into()
}

pub struct Fetched {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub url: String,
    pub redirected: bool,
    pub body: Bytes,
}

pub struct Fetcher {
    follow: reqwest::Client,
    manual: reqwest::Client,
    allow_private: bool,
    timeout: Duration,
}

impl Fetcher {
    /// `extra_ca`: a PEM bundle trusted besides the usual roots (tests: a
    /// stand-in for an app's outside services).
    pub fn new(allow_private: bool, timeout: Duration, extra_ca: Option<&std::path::Path>) -> Result<Arc<Self>> {
        let extra: Vec<reqwest::Certificate> = match extra_ca {
            Some(p) => reqwest::Certificate::from_pem_bundle(&std::fs::read(p)?)?,
            None => vec![],
        };
        let make = |follow: bool| -> Result<reqwest::Client> {
            let mut b = reqwest::Client::builder().pool_idle_timeout(Duration::from_secs(30)).connect_timeout(Duration::from_secs(10)).user_agent("node");
            for c in &extra {
                b = b.add_root_certificate(c.clone());
            }
            if !allow_private {
                b = b.dns_resolver(Arc::new(PublicOnly));
            }
            b = if follow {
                b.redirect(Policy::custom(move |a: Attempt| {
                    if a.previous().len() >= 20 {
                        a.error("redirect count exceeded")
                    } else if !allow_private && literal_private(a.url()) {
                        a.error("redirect to a private address")
                    } else {
                        a.follow()
                    }
                }))
            } else {
                b.redirect(Policy::none())
            };
            Ok(b.build()?)
        };
        Ok(Arc::new(Fetcher { follow: make(true)?, manual: make(false)?, allow_private, timeout }))
    }

    pub async fn fetch(&self, call: FetchCall, body: Option<Bytes>, deadline: Duration) -> Result<Fetched, (String, bool)> {
        let url = reqwest::Url::parse(&call.u).map_err(|e| (format!("invalid URL: {e}"), false))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err((format!("{} URLs are not available", url.scheme()), false));
        }
        if !self.allow_private && literal_private(&url) {
            return Err(("calls to private addresses are not allowed".into(), false));
        }
        let mode = call.r.as_deref().unwrap_or("follow");
        let client = if mode == "follow" { &self.follow } else { &self.manual };
        let method = reqwest::Method::from_bytes(call.m.to_ascii_uppercase().as_bytes()).map_err(|_| ("invalid method".to_string(), false))?;
        let limit = call.t.map(Duration::from_millis).unwrap_or(self.timeout).min(self.timeout).min(deadline);
        let mut req = client.request(method, url).timeout(limit);
        for (k, v) in &call.h {
            let lk = k.to_ascii_lowercase();
            if matches!(lk.as_str(), "host" | "connection" | "content-length" | "transfer-encoding" | "keep-alive" | "upgrade") {
                continue;
            }
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let res = req.send().await.map_err(|e| (describe(&e), e.is_timeout()))?;
        if mode == "error" && res.status().is_redirection() {
            return Err(("unexpected redirect".into(), false));
        }
        let status = res.status();
        let final_url = res.url().to_string();
        let headers = res.headers().iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
        let mut res = res;
        let mut buf = bytes::BytesMut::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| (describe(&e), e.is_timeout()))? {
            if buf.len() + chunk.len() > MAX_BODY {
                return Err((format!("response body over {} MiB", MAX_BODY >> 20), false));
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(Fetched {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers,
            redirected: final_url != call.u && mode == "follow",
            url: final_url,
            body: buf.freeze(),
        })
    }
}

fn describe(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(x) = src {
        s.push_str(": ");
        s.push_str(&x.to_string());
        src = x.source();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses() {
        for p in ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.0.1", "172.16.5.4", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(is_private(p.parse().unwrap()), "{p}");
        }
        for p in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"] {
            assert!(!is_private(p.parse().unwrap()), "{p}");
        }
    }
}
