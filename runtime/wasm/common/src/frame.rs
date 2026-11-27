//! Frames between the runner and the data service: a u32 little-endian
//! length, then that many bytes of JSON.

use anyhow::{bail, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest frame either side accepts (a batch of results can be big).
pub const MAX_FRAME: usize = 64 << 20;

pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> Result<Vec<u8>> {
    let mut h = [0u8; 4];
    r.read_exact(&mut h).await?;
    let n = u32::from_le_bytes(h) as usize;
    if n > MAX_FRAME {
        bail!("frame of {n} bytes is over the limit");
    }
    let mut b = vec![0u8; n];
    r.read_exact(&mut b).await?;
    Ok(b)
}

pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, body: &[u8]) -> Result<()> {
    if body.len() > MAX_FRAME {
        bail!("frame of {} bytes is over the limit", body.len());
    }
    let mut f = Vec::with_capacity(4 + body.len());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(body);
    w.write_all(&f).await?;
    Ok(())
}

/// Encodes one frame into a buffer (for callers that write it themselves).
pub fn encode(body: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(4 + body.len());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(body);
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip() {
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        write(&mut a, b"{\"x\":1}").await.unwrap();
        write(&mut a, b"").await.unwrap();
        assert_eq!(read(&mut b).await.unwrap(), b"{\"x\":1}");
        assert_eq!(read(&mut b).await.unwrap(), b"");
        assert_eq!(encode(b"ab"), vec![2, 0, 0, 0, b'a', b'b']);
    }

    #[tokio::test]
    async fn refuses_oversized() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&((MAX_FRAME as u32) + 1).to_le_bytes()).await.unwrap();
        assert!(read(&mut b).await.is_err());
    }
}
