'use strict';

// A write as a workflow transition makes it (`SET LOCAL app.wf_writer`), for
// a fixture that sets up a state only a machine may write: a bench trial's
// claim (the bench lane's), an eval trial's (the shots eval lane's).

async function asTransition(pool, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
    const out = await client.query(sql, params);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { asTransition };
