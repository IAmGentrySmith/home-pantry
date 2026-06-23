import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

// In production the add-on stores its database on its private, always-mapped
// /data volume (it survives restarts and updates and is not shared with other
// add-ons). Development uses a local ./data directory.
const dbDir = process.env.NODE_ENV === 'development' ? './data' : (process.env.DB_DIR || '/data');
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.error(`Failed to create db directory at ${dbDir}`, err);
  }
}

const dbPath = path.join(dbDir, 'pantry.sqlite');

// One-time migration: earlier versions stored the DB under /share/home_pantry.
// If the new /data location is empty but the old file exists, copy it across
// (including the WAL sidecars) so an existing pantry is preserved on upgrade.
function migrateLegacyShareDb() {
  if (process.env.NODE_ENV === 'development') return;
  const legacy = '/share/home_pantry/pantry.sqlite';
  try {
    if (!fs.existsSync(dbPath) && fs.existsSync(legacy)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(legacy + suffix)) fs.copyFileSync(legacy + suffix, dbPath + suffix);
      }
      console.log(`Migrated existing database from ${legacy} to ${dbPath}`);
    }
  } catch (err) {
    console.error('Failed to migrate legacy /share database:', err.message);
  }
}
migrateLegacyShareDb();

const db = new sqlite3.Database(dbPath);

// Promisified query/run, declared early so the migration runner can use them.
export const query = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

export const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve({ id: this.lastID, changes: this.changes });
  });
});

/**
 * Run `fn` inside a single transaction: COMMIT on success, ROLLBACK on error.
 * sqlite3 serializes statements on the one connection, so BEGIN IMMEDIATE ...
 * COMMIT gives real atomicity for multi-statement operations such as merges.
 */
export async function withTransaction(fn) {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    await run('COMMIT');
    return result;
  } catch (err) {
    try { await run('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw err;
  }
}

// Ordered schema migrations. Index N upgrades the DB from user_version N to N+1.
// Append new migrations; never edit a shipped one in place. CREATE ... IF NOT
// EXISTS keeps v1 idempotent for databases created before user_version existed.
const MIGRATIONS = [
  // v1 -> baseline schema
  async () => {
    await run(`CREATE TABLE IF NOT EXISTS products (
      upc TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      default_expiration_days INTEGER
    )`);
    await run(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upc TEXT NOT NULL,
      added_date TEXT NOT NULL,
      expiration_date TEXT,
      quantity INTEGER DEFAULT 1,
      consumed BOOLEAN DEFAULT 0,
      FOREIGN KEY(upc) REFERENCES products(upc)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS upc_aliases (
      alias_upc TEXT PRIMARY KEY,
      target_upc TEXT NOT NULL,
      FOREIGN KEY(target_upc) REFERENCES products(upc)
    )`);
  },
  // v2 -> audit timestamps (also enables purging old consumed rows)
  async () => {
    await run(`ALTER TABLE products ADD COLUMN created_at TEXT`);
    await run(`ALTER TABLE inventory ADD COLUMN created_at TEXT`);
    await run(`ALTER TABLE inventory ADD COLUMN consumed_at TEXT`);
  },
];

export async function initDb() {
  // PRAGMAs must be applied (and awaited) before any schema work — issuing them
  // fire-and-forget at module load raced the first queries.
  await run('PRAGMA journal_mode=WAL');
  await run('PRAGMA foreign_keys=ON');

  const rows = await query('PRAGMA user_version');
  let version = rows[0]?.user_version ?? 0;
  for (; version < MIGRATIONS.length; version++) {
    await MIGRATIONS[version]();
    // PRAGMA can't be parameterized; the value is our own integer array index.
    await run(`PRAGMA user_version = ${version + 1}`);
  }
}

/** Delete consumed inventory rows older than `days` to bound table growth. */
export async function purgeOldConsumed(days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const result = await run(
    `DELETE FROM inventory WHERE consumed = 1 AND consumed_at IS NOT NULL AND consumed_at < ?`,
    [cutoff.toISOString()]
  );
  if (result.changes > 0) console.log(`Purged ${result.changes} consumed item(s) older than ${days} days.`);
  return result.changes;
}

/**
 * Cleanly close the database connection.
 * Returns a promise that resolves when the connection is fully closed.
 */
export function closeDb() {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err.message);
        reject(err);
      } else {
        console.log('Database connection closed cleanly.');
        resolve();
      }
    });
  });
}

export default db;
