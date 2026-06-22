import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

const dbDir = process.env.NODE_ENV === 'development' ? './data' : '/share/home_pantry';
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.error(`Failed to create db directory at ${dbDir}`, err);
  }
}

const dbPath = path.join(dbDir, 'pantry.sqlite');
const db = new sqlite3.Database(dbPath);

// Enable WAL mode for better concurrent read performance and crash resilience
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA foreign_keys=ON');

export function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Products table
      db.run(`CREATE TABLE IF NOT EXISTS products (
        upc TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        default_expiration_days INTEGER
      )`, (err) => { if (err) reject(err); });

      // Inventory table
      db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upc TEXT NOT NULL,
        added_date TEXT NOT NULL,
        expiration_date TEXT,
        quantity INTEGER DEFAULT 1,
        consumed BOOLEAN DEFAULT 0,
        FOREIGN KEY(upc) REFERENCES products(upc)
      )`, (err) => {
        if (err) return reject(err);
        
        // Aliases table for merging
        db.run(`CREATE TABLE IF NOT EXISTS upc_aliases (
          alias_upc TEXT PRIMARY KEY,
          target_upc TEXT NOT NULL,
          FOREIGN KEY(target_upc) REFERENCES products(upc)
        )`, (err2) => {
          if (err2) reject(err2);
          else resolve();
        });
      });
    });
  });
}

// Promisified query methods
export const query = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

export const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve({ id: this.lastID, changes: this.changes });
  });
});

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
