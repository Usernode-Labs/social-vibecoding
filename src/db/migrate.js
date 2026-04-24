const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { getPool } = require('./pool');
const log = require('../services/logger');

async function migrate(config) {
  const pool = getPool(config);

  const schema = fs.readFileSync(
    path.join(__dirname, 'schema.sql'),
    'utf-8'
  );

  log.info('db', 'Running migrations...');
  await pool.query(schema);
  log.info('db', 'Schema up to date');

  await seedAdmin(pool, config);
}

async function seedAdmin(pool, config) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [config.adminUsername]
  );

  if (rows.length === 0) {
    const hash = await bcrypt.hash(config.adminPassword, 12);
    await pool.query(
      'INSERT INTO users (username, password, is_admin) VALUES ($1, $2, TRUE)',
      [config.adminUsername, hash]
    );
    log.info('db', 'Admin user created', { username: config.adminUsername });
  } else {
    log.debug('db', 'Admin user already exists');
  }
}

module.exports = { migrate };
