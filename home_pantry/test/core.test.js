/**
 * Unit tests for home-pantry core business logic.
 * 
 * Run with: npm test (or: node --test test/)
 * 
 * These tests cover pure logic helpers and database operations
 * without requiring a running Express server or external APIs.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, query, run, closeDb, withTransaction, purgeOldConsumed } from '../db.js';
import {
  escapeLike, isValidUPC, computeExpirationDate, toLocalISODate,
  parseShelfLifeDays, isValidCalendarDate,
} from '../helpers.js';

// Set environment to development so the DB uses ./data/ instead of /data/.
// (npm test also sets NODE_ENV=development in the environment before import.)
process.env.NODE_ENV = 'development';

describe('Database Operations', () => {
  before(async () => {
    await initDb();
  });

  after(async () => {
    // Cleanup test data
    try {
      await run(`DELETE FROM inventory`);
      await run(`DELETE FROM upc_aliases`);
      await run(`DELETE FROM products`);
    } catch {
      // Tables may not exist
    }
    await closeDb();
  });

  beforeEach(async () => {
    // Clean tables before each test
    await run(`DELETE FROM inventory`);
    await run(`DELETE FROM upc_aliases`);
    await run(`DELETE FROM products`);
  });

  it('should create a product and retrieve it', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0123456789012', 'Test Milk', 'Dairy', 7]
    );

    const products = await query(`SELECT * FROM products WHERE upc = ?`, ['0123456789012']);
    assert.equal(products.length, 1);
    assert.equal(products[0].name, 'Test Milk');
    assert.equal(products[0].category, 'Dairy');
    assert.equal(products[0].default_expiration_days, 7);
  });

  it('should add inventory and join with products', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0123456789012', 'Test Butter', 'Dairy', 30]
    );
    await run(
      `INSERT INTO inventory (upc, added_date, expiration_date) VALUES (?, ?, ?)`,
      ['0123456789012', '2026-01-01', '2026-01-31']
    );

    const items = await query(`
      SELECT i.id, i.upc, p.name, p.category, i.expiration_date, i.consumed
      FROM inventory i JOIN products p ON i.upc = p.upc
      WHERE i.consumed = 0
    `);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Test Butter');
    assert.equal(items[0].consumed, 0);
  });

  it('should mark an item as consumed', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0123456789012', 'Test Eggs', 'Dairy', 21]
    );
    const { id } = await run(
      `INSERT INTO inventory (upc, added_date, expiration_date) VALUES (?, ?, ?)`,
      ['0123456789012', '2026-01-01', '2026-01-22']
    );

    await run(`UPDATE inventory SET consumed = 1 WHERE id = ?`, [id]);

    const active = await query(`SELECT * FROM inventory WHERE consumed = 0`);
    assert.equal(active.length, 0);

    const consumed = await query(`SELECT * FROM inventory WHERE consumed = 1`);
    assert.equal(consumed.length, 1);
  });

  it('should create and resolve UPC aliases', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0000000000001', 'Brand Milk', 'Dairy', 7]
    );
    await run(
      `INSERT OR REPLACE INTO upc_aliases (alias_upc, target_upc) VALUES (?, ?)`,
      ['0000000000002', '0000000000001']
    );

    const aliases = await query(`SELECT target_upc FROM upc_aliases WHERE alias_upc = ?`, ['0000000000002']);
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0].target_upc, '0000000000001');
  });

  it('should enforce product UPC uniqueness', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0123456789012', 'First Product', 'Misc', 14]
    );

    await assert.rejects(
      () => run(
        `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
        ['0123456789012', 'Duplicate Product', 'Misc', 14]
      ),
      /UNIQUE constraint failed/
    );
  });

  it('should update only provided product fields (partial update pattern)', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0123456789012', 'Original Name', 'Original Category', 14]
    );

    // Simulate partial update: only change name, keep other fields
    const existing = await query(`SELECT * FROM products WHERE upc = ?`, ['0123456789012']);
    const current = existing[0];

    const updatedName = 'New Name';
    const updatedCategory = current.category; // unchanged
    const updatedDays = current.default_expiration_days; // unchanged

    await run(
      `UPDATE products SET name = ?, category = ?, default_expiration_days = ? WHERE upc = ?`,
      [updatedName, updatedCategory, updatedDays, '0123456789012']
    );

    const result = await query(`SELECT * FROM products WHERE upc = ?`, ['0123456789012']);
    assert.equal(result[0].name, 'New Name');
    assert.equal(result[0].category, 'Original Category');
    assert.equal(result[0].default_expiration_days, 14);
  });

  it('products default to restock = 1, and the flag can be set to 0', async () => {
    // Mirrors /api/consume's check: restock = 0 means "leave off the shopping list".
    await run(`INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['000000000010', 'Pantry Staple', 'Misc', 7]);
    const staple = await query(`SELECT restock FROM products WHERE upc = ?`, ['000000000010']);
    assert.equal(staple[0].restock, 1); // new rows default to restock (migration default)

    await run(`INSERT INTO products (upc, name, category, default_expiration_days, restock) VALUES (?, ?, ?, ?, 0)`,
      ['000000000011', 'Fresh Salmon', 'Seafood', 2]);
    const salmon = await query(`SELECT restock FROM products WHERE upc = ?`, ['000000000011']);
    assert.equal(salmon[0].restock, 0); // explicitly flagged "don't restock"
  });

  it('should find expiring items within the next 7 days', async () => {
    await run(
      `INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['0000000000001', 'Expiring Yogurt', 'Dairy', 5]
    );

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const inTwoWeeks = new Date(today);
    inTwoWeeks.setDate(today.getDate() + 14);

    // Item expiring tomorrow — should be found
    await run(
      `INSERT INTO inventory (upc, added_date, expiration_date) VALUES (?, ?, ?)`,
      ['0000000000001', today.toISOString().split('T')[0], tomorrow.toISOString().split('T')[0]]
    );

    // Item expiring in 2 weeks — should NOT be found
    await run(
      `INSERT INTO inventory (upc, added_date, expiration_date, consumed) VALUES (?, ?, ?, 0)`,
      ['0000000000001', today.toISOString().split('T')[0], inTwoWeeks.toISOString().split('T')[0]]
    );

    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);

    const expiring = await query(`
      SELECT i.id, p.name, i.expiration_date 
      FROM inventory i
      JOIN products p ON i.upc = p.upc
      WHERE i.consumed = 0 AND i.expiration_date <= ? AND i.expiration_date >= ?
    `, [nextWeek.toISOString().split('T')[0], today.toISOString().split('T')[0]]);

    assert.equal(expiring.length, 1);
    assert.equal(expiring[0].name, 'Expiring Yogurt');
  });

  it('should chain-merge products without violating foreign keys', async () => {
    // Mirrors the /api/merge_products transaction. Before the fix, merging
    // B -> C after A -> B threw a FOREIGN KEY error on the source delete.
    for (const upc of ['000000000001', '000000000002', '000000000003']) {
      await run(`INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
        [upc, 'P' + upc, 'Misc', 7]);
      await run(`INSERT INTO inventory (upc, added_date, expiration_date) VALUES (?, ?, ?)`,
        [upc, '2026-01-01', '2026-02-01']);
    }
    const merge = (source, target) => withTransaction(async () => {
      await run(`UPDATE inventory SET upc = ? WHERE upc = ?`, [target, source]);
      await run(`UPDATE upc_aliases SET target_upc = ? WHERE target_upc = ?`, [target, source]);
      await run(`INSERT OR REPLACE INTO upc_aliases (alias_upc, target_upc) VALUES (?, ?)`, [source, target]);
      await run(`DELETE FROM products WHERE upc = ?`, [source]);
    });

    await merge('000000000001', '000000000002'); // A -> B
    await merge('000000000002', '000000000003'); // B -> C

    const cInv = await query(`SELECT COUNT(*) AS n FROM inventory WHERE upc = ?`, ['000000000003']);
    assert.equal(cInv[0].n, 3);
    const remaining = await query(`SELECT upc FROM products`);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].upc, '000000000003');
    // Alias A was re-pointed to C, not left dangling at the deleted B
    const aliasA = await query(`SELECT target_upc FROM upc_aliases WHERE alias_upc = ?`, ['000000000001']);
    assert.equal(aliasA[0].target_upc, '000000000003');
  });

  it('purgeOldConsumed should delete only old consumed rows', async () => {
    await run(`INSERT INTO products (upc, name, category, default_expiration_days) VALUES (?, ?, ?, ?)`,
      ['000000000009', 'Old', 'Misc', 7]);
    const old = new Date(); old.setDate(old.getDate() - 200);
    await run(`INSERT INTO inventory (upc, added_date, expiration_date, consumed, consumed_at) VALUES (?, ?, ?, 1, ?)`,
      ['000000000009', '2025-01-01', '2025-02-01', old.toISOString()]);
    await run(`INSERT INTO inventory (upc, added_date, expiration_date, consumed, consumed_at) VALUES (?, ?, ?, 1, ?)`,
      ['000000000009', '2026-01-01', '2026-02-01', new Date().toISOString()]);
    await run(`INSERT INTO inventory (upc, added_date, expiration_date) VALUES (?, ?, ?)`,
      ['000000000009', '2026-06-01', '2026-07-01']);

    const purged = await purgeOldConsumed(90);
    assert.equal(purged, 1);
    const remaining = await query(`SELECT COUNT(*) AS n FROM inventory`);
    assert.equal(remaining[0].n, 2);
  });
});

describe('Helper Functions (real implementations from helpers.js)', () => {
  it('isValidUPC should accept standard barcode formats', () => {
    assert.equal(isValidUPC('012345678905'), true);    // UPC-A (12 digits)
    assert.equal(isValidUPC('0123456789012'), true);   // EAN-13 (13 digits)
    assert.equal(isValidUPC('01234567'), true);         // EAN-8 (8 digits)
    assert.equal(isValidUPC('generic_123456'), true);  // Internal generic
    assert.equal(isValidUPC(''), false);               // Empty
    assert.equal(isValidUPC(null), false);             // Null
    assert.equal(isValidUPC('abc'), false);            // Non-numeric
    assert.equal(isValidUPC('12345'), false);          // Too short
    assert.equal(isValidUPC('123456789012345'), false); // Too long (15 digits)
  });

  it('escapeLike should escape LIKE wildcards', () => {
    assert.equal(escapeLike('milk'), 'milk');
    assert.equal(escapeLike('100%'), '100\\%');
    assert.equal(escapeLike('_test_'), '\\_test\\_');
    assert.equal(escapeLike('%_%'), '\\%\\_\\%');
  });

  it('computeExpirationDate returns null for non-perishable, else a local date', () => {
    assert.equal(computeExpirationDate(0), null);
    assert.equal(computeExpirationDate(null), null);
    assert.equal(computeExpirationDate(-1), null);

    const result = computeExpirationDate(7);
    assert.ok(result);
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);

    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    assert.equal(result, toLocalISODate(expected));
  });

  it('parseShelfLifeDays preserves a genuine 0 and defaults only on no number', () => {
    assert.equal(parseShelfLifeDays('0'), 0);          // non-perishable preserved (was the bug)
    assert.equal(parseShelfLifeDays('7'), 7);
    assert.equal(parseShelfLifeDays('about 10 days'), 10);
    assert.equal(parseShelfLifeDays(''), 14);          // empty -> default
    assert.equal(parseShelfLifeDays('unknown'), 14);   // no digits -> default
    assert.equal(parseShelfLifeDays(14), 14);
  });

  it('isValidCalendarDate rejects bad formats and overflows', () => {
    assert.equal(isValidCalendarDate('2026-06-23'), true);
    assert.equal(isValidCalendarDate('2024-02-29'), true);  // valid leap day
    assert.equal(isValidCalendarDate('2026-02-30'), false); // overflow
    assert.equal(isValidCalendarDate('2026-99-99'), false); // impossible
    assert.equal(isValidCalendarDate('2026-6-3'), false);   // wrong format
    assert.equal(isValidCalendarDate('not-a-date'), false);
    assert.equal(isValidCalendarDate(null), false);
  });
});
