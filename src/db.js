const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let rawDbUrl = (process.env.DATABASE_URL || '').trim();
// Remove accidental surrounding quotes
if ((rawDbUrl.startsWith('"') && rawDbUrl.endsWith('"')) || (rawDbUrl.startsWith("'") && rawDbUrl.endsWith("'"))) {
  rawDbUrl = rawDbUrl.slice(1, -1).trim();
}

let isPostgres = false;
let pgPool = null;
let db = null;

if (rawDbUrl && (rawDbUrl.startsWith('postgres://') || rawDbUrl.startsWith('postgresql://'))) {
  try {
    const { Pool } = require('pg');
    // Ensure ssl config
    const isSslNeeded = !rawDbUrl.includes('localhost') && !rawDbUrl.includes('127.0.0.1');
    pgPool = new Pool({
      connectionString: rawDbUrl,
      ssl: isSslNeeded ? { rejectUnauthorized: false } : false
    });
    isPostgres = true;
    console.log('Using PostgreSQL Cloud Database via DATABASE_URL');
  } catch (err) {
    console.error('Failed to initialize PostgreSQL pool, falling back to SQLite:', err.message);
    isPostgres = false;
  }
}

if (!isPostgres) {
  const dbPath = path.resolve(__dirname, '../database.sqlite');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Failed to open SQLite database:', err.message);
    } else {
      console.log('Connected to SQLite database at', dbPath);
    }
  });
}

// Convert SQLite ? placeholders to Postgres $1, $2 if needed
function adaptSql(sql) {
  if (!isPostgres) return sql;
  let paramIndex = 1;
  return sql.replace(/\?/g, () => `$${paramIndex++}`)
            .replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
            .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
            .replace(/AUTOINCREMENT/gi, 'SERIAL');
}

// Helper for promise-based queries
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (isPostgres && pgPool) {
      const adapted = adaptSql(sql);
      pgPool.query(adapted, params, (err, res) => {
        if (err) {
          console.error('Postgres query error:', err.message, 'SQL:', adapted);
          reject(err);
        } else {
          resolve({ id: res.rows?.[0]?.id || (res.rowCount > 0 ? 1 : 0), changes: res.rowCount });
        }
      });
    } else {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    }
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (isPostgres && pgPool) {
      const adapted = adaptSql(sql);
      pgPool.query(adapted, params, (err, res) => {
        if (err) {
          console.error('Postgres get error:', err.message);
          reject(err);
        } else {
          resolve(res.rows[0] || null);
        }
      });
    } else {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    }
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (isPostgres && pgPool) {
      const adapted = adaptSql(sql);
      pgPool.query(adapted, params, (err, res) => {
        if (err) {
          console.error('Postgres all error:', err.message);
          reject(err);
        } else {
          resolve(res.rows || []);
        }
      });
    } else {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    }
  });
}

// Initialize tables
async function initDb() {
  try {
    if (isPostgres) {
      await run(`
        CREATE TABLE IF NOT EXISTS bots (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          username TEXT,
          token TEXT NOT NULL UNIQUE,
          welcome_message TEXT DEFAULT 'Hello {first_name}! Welcome to our bot 🎉',
          welcome_photo TEXT DEFAULT '',
          welcome_buttons TEXT DEFAULT '[]',
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS subscribers (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          telegram_id TEXT NOT NULL,
          first_name TEXT,
          last_name TEXT,
          username TEXT,
          is_blocked INTEGER DEFAULT 0,
          last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(bot_id, telegram_id)
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
          direction TEXT NOT NULL,
          text TEXT,
          media_type TEXT DEFAULT 'text',
          media_url TEXT DEFAULT '',
          is_read INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id SERIAL PRIMARY KEY,
          bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          text TEXT NOT NULL,
          photo_url TEXT DEFAULT '',
          buttons TEXT DEFAULT '[]',
          total_target INTEGER DEFAULT 0,
          total_sent INTEGER DEFAULT 0,
          total_blocked INTEGER DEFAULT 0,
          total_failed INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP
        )
      `);
    } else {
      await run(`
        CREATE TABLE IF NOT EXISTS bots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          username TEXT,
          token TEXT NOT NULL UNIQUE,
          welcome_message TEXT DEFAULT 'Hello {first_name}! Welcome to our bot 🎉',
          welcome_photo TEXT DEFAULT '',
          welcome_buttons TEXT DEFAULT '[]',
          is_active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS subscribers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id INTEGER NOT NULL,
          telegram_id TEXT NOT NULL,
          first_name TEXT,
          last_name TEXT,
          username TEXT,
          is_blocked INTEGER DEFAULT 0,
          last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(bot_id, telegram_id),
          FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id INTEGER NOT NULL,
          subscriber_id INTEGER NOT NULL,
          direction TEXT NOT NULL,
          text TEXT,
          media_type TEXT DEFAULT 'text',
          media_url TEXT DEFAULT '',
          is_read INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE,
          FOREIGN KEY(subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
        )
      `);

      await run(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          text TEXT NOT NULL,
          photo_url TEXT DEFAULT '',
          buttons TEXT DEFAULT '[]',
          total_target INTEGER DEFAULT 0,
          total_sent INTEGER DEFAULT 0,
          total_blocked INTEGER DEFAULT 0,
          total_failed INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )
      `);
    }
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error during initDb:', err);
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb
};
