//! Running one statement on a connection, as node-pg would: with parameters
//! (always sent as text, Postgres infers their types) as a prepared
//! statement; without, as a prepared statement too unless the string holds
//! several statements (a migration), which then runs as a simple query.

use crate::pool::Conn;
use crate::values;
use bytes::BytesMut;
use futures::TryStreamExt;
use serde_json::{json, Value};
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::types::{IsNull, ToSql, Type};
use tokio_postgres::SimpleQueryMessage;

/// A parameter as text (node-pg sends every value as text too).
#[derive(Debug)]
pub struct Text(pub Option<String>);
impl ToSql for Text {
    fn to_sql(&self, _: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match &self.0 {
            None => Ok(IsNull::Yes),
            Some(s) => {
                out.extend_from_slice(s.as_bytes());
                Ok(IsNull::No)
            }
        }
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> tokio_postgres::types::Format {
        tokio_postgres::types::Format::Text
    }
    tokio_postgres::types::to_sql_checked!();
}

/// What a failed statement tells the app (node-pg's error fields).
pub fn error_json(e: &tokio_postgres::Error) -> Value {
    match e.as_db_error() {
        Some(d) => {
            let mut v = json!({ "e": d.message(), "code": d.code().code(), "severity": d.severity() });
            let m = v.as_object_mut().unwrap();
            for (k, x) in [
                ("detail", d.detail()),
                ("hint", d.hint()),
                ("schema", d.schema()),
                ("table", d.table()),
                ("column", d.column()),
                ("constraint", d.constraint()),
                ("where", d.where_()),
                ("routine", d.routine()),
            ] {
                if let Some(x) = x {
                    m.insert(k.into(), Value::String(x.into()));
                }
            }
            if let Some(ErrorPosition::Original(p)) = d.position() {
                m.insert("position".into(), Value::String(p.to_string()));
            }
            v
        }
        None => json!({ "e": error_text(e) }),
    }
}

pub fn error_text(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(d) => d.message().to_string(),
        None => {
            let mut s = e.to_string();
            let mut src = std::error::Error::source(e);
            while let Some(x) = src {
                s.push_str(": ");
                s.push_str(&x.to_string());
                src = x.source();
            }
            s
        }
    }
}

/// The transaction statement this is, if any: BEGIN, START TRANSACTION,
/// COMMIT, END, ROLLBACK, ABORT (not ROLLBACK TO SAVEPOINT, not PREPARE TRANSACTION).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxControl {
    Begin,
    End,
}
pub fn tx_control(sql: &str) -> Option<TxControl> {
    let s = values::skip_comments(sql).to_ascii_uppercase();
    let words: Vec<&str> = s.split(|c: char| c.is_whitespace() || c == ';').filter(|w| !w.is_empty()).take(2).collect();
    match words.as_slice() {
        ["BEGIN", ..] | ["START", "TRANSACTION"] => Some(TxControl::Begin),
        ["COMMIT", next] | ["END", next] | ["ROLLBACK", next] | ["ABORT", next] if *next != "TO" && *next != "PREPARED" => Some(TxControl::End),
        ["COMMIT"] | ["END"] | ["ROLLBACK"] | ["ABORT"] => Some(TxControl::End),
        _ => None,
    }
}

/// Whether a statement only reads (and so may run beside others, or again).
pub fn is_read(sql: &str) -> bool {
    let c = values::command_of(sql);
    matches!(c.as_str(), "SELECT" | "SHOW" | "VALUES" | "TABLE" | "EXPLAIN") && !mentions_write(sql)
        || (c == "WITH" && !mentions_write(sql))
}
fn mentions_write(sql: &str) -> bool {
    let u = sql.to_ascii_uppercase();
    ["INSERT ", "UPDATE ", "DELETE ", "MERGE ", " FOR UPDATE", " FOR SHARE", " FOR NO KEY", "NEXTVAL(", "SETVAL(", "PG_ADVISORY"].iter().any(|w| u.contains(w))
}

/// Runs one statement; the answer is the result's JSON.
pub async fn run(conn: &mut Conn, sql: &str, params: &[Option<String>]) -> Result<String, tokio_postgres::Error> {
    if params.is_empty() {
        if let Some(tx) = tx_control(sql) {
            conn.client.batch_execute(sql).await?;
            conn.in_tx = tx == TxControl::Begin;
            return Ok(format!("{{\"f\":[],\"t\":[],\"n\":0,\"cmd\":\"{}\",\"rows\":[]}}", values::command_of(sql)));
        }
    }
    match prepared(conn, sql, params).await {
        Err(e) if params.is_empty() && is_multi_statement(&e) => simple(conn, sql).await,
        Err(e) if !conn.in_tx && is_stale_plan(&e) => {
            // The table changed under a cached statement (a migration ran): prepare it again.
            conn.forget(sql);
            prepared(conn, sql, params).await
        }
        r => {
            if let Err(e) = &r {
                if conn.in_tx && e.as_db_error().is_none() {
                    conn.in_tx = false;
                }
            }
            r
        }
    }
}

async fn prepared(conn: &mut Conn, sql: &str, params: &[Option<String>]) -> Result<String, tokio_postgres::Error> {
    let st = conn.prepare(sql).await?;
    let args: Vec<Text> = params.iter().cloned().map(Text).collect();
    // A statement with fewer parameters than values (or more) fails in Postgres, as in node-pg.
    let stream = conn.client.query_raw(&st, args.iter().map(|a| a as &(dyn ToSql + Sync))).await?;
    futures::pin_mut!(stream);
    let mut rows = vec![];
    while let Some(r) = stream.try_next().await? {
        rows.push(r);
    }
    let affected = stream.rows_affected();
    Ok(values::result_json(st.columns(), &rows, affected, &values::command_of(sql)))
}

async fn simple(conn: &mut Conn, sql: &str) -> Result<String, tokio_postgres::Error> {
    let msgs = conn.client.simple_query(sql).await?;
    let (mut names, mut rows, mut affected) = (vec![], vec![], 0u64);
    for m in msgs {
        match m {
            SimpleQueryMessage::RowDescription(cols) => {
                names = cols.iter().map(|c| c.name().to_string()).collect();
                rows.clear();
            }
            SimpleQueryMessage::Row(r) => {
                if names.is_empty() {
                    names = r.columns().iter().map(|c| c.name().to_string()).collect();
                }
                rows.push((0..r.len()).map(|i| r.get(i).map(str::to_string)).collect::<Vec<_>>());
            }
            SimpleQueryMessage::CommandComplete(n) => affected = n,
            _ => {}
        }
    }
    // Several statements: the transaction state is whatever they left; assume none open.
    Ok(values::simple_json(&names, &rows, affected, &values::command_of(sql)))
}

fn is_multi_statement(e: &tokio_postgres::Error) -> bool {
    e.as_db_error().is_some_and(|d| d.code().code() == "42601" && d.message().contains("multiple commands"))
}
fn is_stale_plan(e: &tokio_postgres::Error) -> bool {
    e.as_db_error().is_some_and(|d| d.code().code() == "0A000" && d.message().contains("cached plan"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_statements() {
        assert_eq!(tx_control("BEGIN"), Some(TxControl::Begin));
        assert_eq!(tx_control("  begin isolation level serializable"), Some(TxControl::Begin));
        assert_eq!(tx_control("START TRANSACTION"), Some(TxControl::Begin));
        assert_eq!(tx_control("COMMIT"), Some(TxControl::End));
        assert_eq!(tx_control("commit;"), Some(TxControl::End));
        assert_eq!(tx_control("ROLLBACK"), Some(TxControl::End));
        assert_eq!(tx_control("ROLLBACK TO SAVEPOINT x"), None);
        assert_eq!(tx_control("COMMIT PREPARED 'x'"), None);
        assert_eq!(tx_control("SAVEPOINT x"), None);
        assert_eq!(tx_control("SELECT 1"), None);
        assert_eq!(tx_control("-- c\nBEGIN"), Some(TxControl::Begin));
    }

    #[test]
    fn reads() {
        assert!(is_read("SELECT * FROM t"));
        assert!(is_read("with x as (select 1) select * from x"));
        assert!(!is_read("SELECT * FROM t FOR UPDATE"));
        assert!(!is_read("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"));
        assert!(!is_read("INSERT INTO t VALUES (1)"));
        assert!(!is_read("SELECT nextval('s')"));
        assert!(!is_read("UPDATE t SET a = 1"));
    }
}
