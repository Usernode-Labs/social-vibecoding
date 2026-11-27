//! The runner's side of the data service: pooled TCP connections carrying
//! frames, and connections pinned to a client (a transaction's statements
//! must all reach the replica that holds it).
//!
//! A statement is tried again on another connection when it never reached
//! the service, or when running it twice is harmless: a read outside a
//! transaction, or anything carrying an operation ID (the service replays).
//! The service's address is looked up once and kept; looked up again after
//! a connection to it fails.

use anyhow::{anyhow, Result};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
/// The service's own statement timeout is 30 s; past this the answer is not coming.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(35);
/// A pooled connection unused this long is closed rather than trusted.
const POOLED_MAX_IDLE: Duration = Duration::from_secs(30);

pub struct Pooled {
    stream: TcpStream,
    last: Instant,
}

pub struct DataClient {
    addr: String,
    resolved: Mutex<Option<Vec<SocketAddr>>>,
    free: Mutex<Vec<Pooled>>,
    pub retries: AtomicU64,
    pub connect_failures: AtomicU64,
}

impl DataClient {
    pub fn new(addr: String) -> Self {
        DataClient { addr, resolved: Mutex::new(None), free: Mutex::new(vec![]), retries: AtomicU64::new(0), connect_failures: AtomicU64::new(0) }
    }

    async fn addresses(&self) -> Result<Vec<SocketAddr>> {
        if let Some(a) = self.resolved.lock().unwrap().clone() {
            return Ok(a);
        }
        let a: Vec<SocketAddr> = tokio::net::lookup_host(self.addr.as_str()).await?.collect();
        if a.is_empty() {
            return Err(anyhow!("{} has no address", self.addr));
        }
        *self.resolved.lock().unwrap() = Some(a.clone());
        Ok(a)
    }

    pub async fn connect(&self) -> Result<TcpStream> {
        let addrs = self.addresses().await?;
        let mut last = anyhow!("no address");
        for a in addrs {
            match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(a)).await {
                Ok(Ok(s)) => {
                    let _ = s.set_nodelay(true);
                    return Ok(s);
                }
                Ok(Err(e)) => last = e.into(),
                Err(_) => last = anyhow!("connecting to the data service timed out"),
            }
        }
        self.connect_failures.fetch_add(1, Relaxed);
        *self.resolved.lock().unwrap() = None;
        Err(last)
    }

    /// A pooled connection that still looks open, or a new one.
    async fn take(&self) -> Result<TcpStream> {
        loop {
            let p = self.free.lock().unwrap().pop();
            let Some(p) = p else { break };
            if p.last.elapsed() > POOLED_MAX_IDLE {
                continue;
            }
            // A closed peer reads as end of file at once; an open one would block.
            let mut probe = [0u8; 1];
            match p.stream.try_read(&mut probe) {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(p.stream),
                _ => continue,
            }
        }
        self.connect().await
    }

    pub fn put_back(&self, stream: TcpStream) {
        let mut f = self.free.lock().unwrap();
        if f.len() < 256 {
            f.push(Pooled { stream, last: Instant::now() });
        }
    }

    /// One exchange; on failure, whether the frame may have reached the service.
    async fn once(s: &mut TcpStream, frame: &[u8]) -> Result<Vec<u8>, (bool, anyhow::Error)> {
        if let Err(e) = s.write_all(frame).await {
            return Err((false, e.into()));
        }
        let read = async {
            let mut h = [0u8; 4];
            s.read_exact(&mut h).await?;
            let n = u32::from_le_bytes(h) as usize;
            if n > wasm_common::frame::MAX_FRAME {
                return Err(std::io::Error::other("answer over the frame limit"));
            }
            let mut b = vec![0u8; n];
            s.read_exact(&mut b).await?;
            Ok::<_, std::io::Error>(b)
        };
        match tokio::time::timeout(ANSWER_TIMEOUT, read).await {
            Ok(Ok(b)) => Ok(b),
            Ok(Err(e)) => Err((true, e.into())),
            Err(_) => Err((true, anyhow!("the data service did not answer in {} s", ANSWER_TIMEOUT.as_secs()))),
        }
    }

    /// A frame on any connection; tried up to three times as the rules above allow.
    pub async fn call(&self, body: &[u8], retry_ok: bool) -> Result<String> {
        let frame = wasm_common::frame::encode(body);
        let mut last = anyhow!("no attempt");
        for attempt in 0..3 {
            if attempt > 0 {
                self.retries.fetch_add(1, Relaxed);
            }
            let mut s = match self.take().await {
                Ok(s) => s,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            match Self::once(&mut s, &frame).await {
                Ok(b) => {
                    self.put_back(s);
                    return String::from_utf8(b).map_err(|_| anyhow!("the data service answered with bad UTF-8"));
                }
                Err((sent, e)) => {
                    last = e;
                    if sent && !retry_ok {
                        return Err(last);
                    }
                }
            }
        }
        Err(last)
    }

    /// A frame on a client's own connection (opened for its first statement).
    /// No retry: the transaction lives on that connection. The connection
    /// comes back unless it failed.
    pub async fn call_pinned(&self, pinned: Option<TcpStream>, body: &[u8]) -> (Result<String>, Option<TcpStream>) {
        let frame = wasm_common::frame::encode(body);
        let mut s = match pinned {
            Some(s) => s,
            None => match self.connect().await {
                Ok(s) => s,
                Err(e) => return (Err(e), None),
            },
        };
        match Self::once(&mut s, &frame).await {
            Ok(b) => (String::from_utf8(b).map_err(|_| anyhow!("the data service answered with bad UTF-8")), Some(s)),
            Err((_, e)) => (Err(e), None),
        }
    }
}
