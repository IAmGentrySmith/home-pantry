import express from 'express';
import { initDb, query, run, closeDb, withTransaction, purgeOldConsumed } from './db.js';
import { lookupUPC } from './upc.js';
import { estimateShelfLife } from './llm.js';
import { addItemsToShoppingList, updateExpiringSensor } from './ha_api.js';
import { getOptions } from './options.js';
import {
  escapeLike, isValidUPC, computeExpirationDate, todayISO,
  toLocalISODate, isValidCalendarDate,
} from './helpers.js';
import { log } from './logger.js';

const app = express();
const port = process.env.PORT || 8099;

// When running as a Home Assistant add-on the Supervisor always sets SUPERVISOR_TOKEN.
// Outside HA (local dev / standalone) there is no ingress layer, so the API auth gate
// below is disabled and access is open.
const RUNNING_AS_ADDON = !!process.env.SUPERVISOR_TOKEN;
const API_TOKEN = getOptions().api_token || '';
// The HA Supervisor proxies all ingress traffic from this fixed IP. Official
// guidance is that add-ons should trust ingress requests ONLY from this source.
const SUPERVISOR_IP = process.env.SUPERVISOR_IP || '172.30.32.2';

function isFromSupervisor(req) {
  const ra = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ra === SUPERVISOR_IP;
}

app.use(express.json());

// Unauthenticated, DB-free health endpoint for the Docker HEALTHCHECK.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use(express.static('public'));

// --- API authentication ---
// The UI is served through HA ingress, which authenticates the user and injects the
// X-Ingress-Path header on every proxied request. Direct hits to the optional,
// default-closed published port do NOT carry that header and must present the
// configured bearer token (api_token). This closes the unauthenticated-LAN hole that
// publishing the port would otherwise open, while keeping the voice REST commands usable.
function apiAuth(req, res, next) {
  if (!RUNNING_AS_ADDON) return next();
  // Genuine ingress requests are proxied by the Supervisor, so they BOTH carry
  // X-Ingress-Path AND originate from the Supervisor IP. Requiring both means a
  // LAN client that reached the optional published port cannot bypass auth by
  // forging the header.
  if (req.get('X-Ingress-Path') !== undefined && isFromSupervisor(req)) return next();
  if (API_TOKEN && req.get('Authorization') === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({
    error: 'Unauthorized. Direct (non-ingress) API access requires a bearer token: set the "api_token" add-on option and send the "Authorization: Bearer <token>" header.'
  });
}
app.use('/api', apiAuth);

// --- Helpers ---

/**
 * Wraps an async Express route handler to catch rejected promises
 * and forward them to Express's error handler.
 * (Express 4 does not do this automatically.)
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Pure helpers (escapeLike, isValidUPC, computeExpirationDate, todayISO,
// isValidCalendarDate) live in helpers.js so the tests exercise the real code.

/** Current timestamp as an ISO string (used for created_at / consumed_at columns). */
const nowIso = () => new Date().toISOString();

/** Reject absurdly long free-text fields to prevent DB bloat / abuse. */
const MAX_TEXT_LEN = 200;
function tooLong(...values) {
  return values.some((v) => typeof v === 'string' && v.length > MAX_TEXT_LEN);
}

/**
 * Presence model: keep at most ONE active (unconsumed) inventory row per product.
 * If one already exists for `upc`, refresh its dates instead of adding a
 * duplicate; otherwise insert a new row. Returns { id, alreadyInStock }.
 */
async function addOrRefreshInventory(upc, expirationDate) {
  const active = await query(
    `SELECT id FROM inventory WHERE upc = ? AND consumed = 0 ORDER BY id DESC LIMIT 1`,
    [upc]
  );
  if (active.length > 0) {
    await run(`UPDATE inventory SET added_date = ?, expiration_date = ? WHERE id = ?`,
      [todayISO(), expirationDate, active[0].id]);
    return { id: active[0].id, alreadyInStock: true };
  }
  const ins = await run(
    `INSERT INTO inventory (upc, added_date, expiration_date, created_at) VALUES (?, ?, ?, ?)`,
    [upc, todayISO(), expirationDate, nowIso()]
  );
  return { id: ins.id, alreadyInStock: false };
}

// --- Routes ---

// 1. Get all inventory
app.get('/api/inventory', asyncHandler(async (req, res) => {
  const items = await query(`
    SELECT i.id, i.upc, i.added_date, i.expiration_date, p.name, p.category, p.default_expiration_days, p.restock
    FROM inventory i
    JOIN products p ON i.upc = p.upc
    WHERE i.consumed = 0
    ORDER BY i.expiration_date ASC
  `);
  res.json(items);
}));

// 2. Scan UPC (Add or Lookup)
app.post('/api/scan', asyncHandler(async (req, res) => {
  const { upc } = req.body;
  if (!upc) return res.status(400).json({ error: "Missing UPC" });
  
  const trimmedUpc = upc.trim();
  if (!isValidUPC(trimmedUpc)) {
    return res.status(400).json({ error: "Invalid UPC format. Expected 8-14 digits." });
  }

  // Resolve aliases
  const aliases = await query(`SELECT target_upc FROM upc_aliases WHERE alias_upc = ?`, [trimmedUpc]);
  const actualUpc = aliases.length > 0 ? aliases[0].target_upc : trimmedUpc;

  let product = await query(`SELECT * FROM products WHERE upc = ?`, [actualUpc]);
  
  if (product.length === 0) {
    const offData = await lookupUPC(actualUpc);
    
    if (!offData || !offData.name || offData.name === "Unknown Product") {
      return res.json({ success: false, needs_info: true, upc: trimmedUpc });
    }
    
    let name = offData.name;
    let category = offData.category || "Misc";
    
    const { days, llm_used } = await estimateShelfLife(name, category);
    
    // INSERT OR IGNORE + re-select: two rapid scans of the same NEW barcode
    // would otherwise both pass the "doesn't exist" check above and the second
    // INSERT would throw a UNIQUE constraint error. OR IGNORE makes it idempotent
    // (use actualUpc — the resolved alias — not the original scanned UPC).
    await run(`INSERT OR IGNORE INTO products (upc, name, category, default_expiration_days, created_at) VALUES (?, ?, ?, ?, ?)`,
      [actualUpc, name, category, days, nowIso()]);

    product = await query(`SELECT * FROM products WHERE upc = ?`, [actualUpc]);

    const prod = product[0];
    const expirationDate = computeExpirationDate(prod.default_expiration_days);
    const inv = await addOrRefreshInventory(prod.upc, expirationDate);

    res.json({ success: true, product: prod, expiration_date: expirationDate, llm_used, id: inv.id, already_in_stock: inv.alreadyInStock });
  } else {
    // Product already existed — no LLM call ran, so report llm_used: false
    const prod = product[0];
    const expirationDate = computeExpirationDate(prod.default_expiration_days);
    const inv = await addOrRefreshInventory(prod.upc, expirationDate);

    res.json({ success: true, product: prod, expiration_date: expirationDate, llm_used: false, id: inv.id, already_in_stock: inv.alreadyInStock });
  }
}));

// 2b. Add Custom Product manually
app.post('/api/scan_custom', asyncHandler(async (req, res) => {
  const { upc, name, category } = req.body;
  if (!upc || !name) return res.status(400).json({ error: "Missing required fields" });
  if (tooLong(name, category)) return res.status(400).json({ error: `Name and category must be ${MAX_TEXT_LEN} characters or fewer.` });

  const trimmedUpc = upc.trim();
  if (!isValidUPC(trimmedUpc)) {
    return res.status(400).json({ error: "Invalid UPC format. Expected 8-14 digits." });
  }

  // Check if this product already exists (prevents UNIQUE constraint errors on rapid double-scans)
  const existing = await query(`SELECT * FROM products WHERE upc = ?`, [trimmedUpc]);
  let prod;

  if (existing.length > 0) {
    prod = existing[0]; // no LLM call ran
  } else {
    const { days, llm_used } = await estimateShelfLife(name, category || "Misc");
    // OR IGNORE + re-select so a concurrent insert of the same UPC can't throw a
    // UNIQUE constraint error (see /api/scan).
    await run(`INSERT OR IGNORE INTO products (upc, name, category, default_expiration_days, created_at) VALUES (?, ?, ?, ?, ?)`,
      [trimmedUpc, name, category || "Misc", days, nowIso()]);
    const row = (await query(`SELECT * FROM products WHERE upc = ?`, [trimmedUpc]))[0];
    prod = { ...row, llm_used };
  }

  const expirationDate = computeExpirationDate(prod.default_expiration_days);
  const inv = await addOrRefreshInventory(prod.upc, expirationDate);

  res.json({ success: true, product: { name: prod.name, category: prod.category }, expiration_date: expirationDate, llm_used: prod.llm_used ?? false, id: inv.id, already_in_stock: inv.alreadyInStock });
}));

// 2d. Add an item manually (no barcode scan)
app.post('/api/add_manual', asyncHandler(async (req, res) => {
  const { name, category, expiration_date, restock } = req.body;
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: "Missing name" });
  if (tooLong(trimmedName, category)) return res.status(400).json({ error: `Name and category must be ${MAX_TEXT_LEN} characters or fewer.` });
  if (expiration_date != null && expiration_date !== '' && !isValidCalendarDate(expiration_date)) {
    return res.status(400).json({ error: "Invalid date. Use a real calendar date in YYYY-MM-DD format." });
  }

  const cat = (category && category.trim()) || "Misc";

  // Reuse an existing product with the same name (case-insensitive) so repeated
  // manual adds don't pile up duplicate generic products. A reused product keeps
  // its own restock preference; the flag below only applies when we create one.
  const existing = await query(`SELECT * FROM products WHERE name = ? COLLATE NOCASE LIMIT 1`, [trimmedName]);
  let prod;
  let llm_used = false;

  if (existing.length > 0) {
    prod = existing[0];
  } else {
    const upc = 'generic_' + Date.now();
    const est = await estimateShelfLife(trimmedName, cat);
    llm_used = est.llm_used;
    const restockVal = (restock === 0 || restock === false) ? 0 : 1;
    await run(`INSERT INTO products (upc, name, category, default_expiration_days, restock, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [upc, trimmedName, cat, est.days, restockVal, nowIso()]);
    prod = { upc, name: trimmedName, category: cat, default_expiration_days: est.days };
  }

  // An explicit date wins; otherwise derive it from the product's shelf life.
  const expirationDate = (expiration_date && expiration_date.trim())
    ? expiration_date.trim()
    : computeExpirationDate(prod.default_expiration_days);

  const inv = await addOrRefreshInventory(prod.upc, expirationDate);

  res.json({ success: true, product: { name: prod.name, category: prod.category }, expiration_date: expirationDate, llm_used, id: inv.id, already_in_stock: inv.alreadyInStock });
}));

// 2c. Merge Products
app.post('/api/merge_products', asyncHandler(async (req, res) => {
  const { source_upc, target_upc } = req.body;
  if (!source_upc || !target_upc || source_upc === target_upc) {
    return res.status(400).json({ error: "Invalid UPCs" });
  }

  // Verify target product exists before merging
  const targetProduct = await query(`SELECT upc FROM products WHERE upc = ?`, [target_upc]);
  if (targetProduct.length === 0) {
    return res.status(404).json({ error: `Target product with UPC ${target_upc} does not exist.` });
  }

  // Atomic so a partial failure can't leave inventory re-pointed but the source
  // product un-deleted. Re-pointing existing aliases first lets chained merges
  // (A->B then B->C) succeed without tripping the upc_aliases foreign key.
  await withTransaction(async () => {
    await run(`UPDATE inventory SET upc = ? WHERE upc = ?`, [target_upc, source_upc]);
    await run(`UPDATE upc_aliases SET target_upc = ? WHERE target_upc = ?`, [target_upc, source_upc]);
    await run(`INSERT OR REPLACE INTO upc_aliases (alias_upc, target_upc) VALUES (?, ?)`, [source_upc, target_upc]);
    await run(`DELETE FROM products WHERE upc = ?`, [source_upc]);
  });
  res.json({ success: true, message: "Products merged successfully" });
}));

// 3. Consume item (marks as consumed; adds to shopping list unless the product
// is flagged restock = 0 — "don't restock this when it's used up")
app.post('/api/consume', asyncHandler(async (req, res) => {
  const { id } = req.body;
  const items = await query(`SELECT p.name, p.restock FROM inventory i JOIN products p ON i.upc = p.upc WHERE i.id = ?`, [id]);
  if (items.length > 0) {
    await run(`UPDATE inventory SET consumed = 1, consumed_at = ? WHERE id = ?`, [nowIso(), id]);
    if (items[0].restock !== 0) {
      await addItemsToShoppingList(items[0].name);
      res.json({ success: true, message: `Consumed ${items[0].name} and added to shopping list.` });
    } else {
      res.json({ success: true, message: `Consumed ${items[0].name}. Not restocked — left off the shopping list.` });
    }
  } else {
    res.status(404).json({ error: "Item not found" });
  }
}));

// 3b. Discard item (marks as consumed WITHOUT adding to shopping list)
app.post('/api/discard', asyncHandler(async (req, res) => {
  const { id } = req.body;
  const items = await query(`SELECT p.name FROM inventory i JOIN products p ON i.upc = p.upc WHERE i.id = ?`, [id]);
  if (items.length > 0) {
    await run(`UPDATE inventory SET consumed = 1, consumed_at = ? WHERE id = ?`, [nowIso(), id]);
    res.json({ success: true, message: `Discarded ${items[0].name}.` });
  } else {
    res.status(404).json({ error: "Item not found" });
  }
}));

// 4. Update Product (partial update — only updates fields that are provided)
app.put('/api/products/:upc', asyncHandler(async (req, res) => {
  const { upc } = req.params;
  const { name, category, default_expiration_days, restock } = req.body;

  if (tooLong(name, category)) return res.status(400).json({ error: `Name and category must be ${MAX_TEXT_LEN} characters or fewer.` });

  // Fetch current product to merge with provided fields
  const existing = await query(`SELECT * FROM products WHERE upc = ?`, [upc]);
  if (existing.length === 0) {
    return res.status(404).json({ error: "Product not found" });
  }
  const current = existing[0];

  const updatedName = name !== undefined ? name : current.name;
  const updatedCategory = category !== undefined ? category : current.category;
  const updatedDays = default_expiration_days !== undefined ? default_expiration_days : current.default_expiration_days;
  const updatedRestock = restock !== undefined ? (restock ? 1 : 0) : current.restock;

  await run(`UPDATE products SET name = ?, category = ?, default_expiration_days = ?, restock = ? WHERE upc = ?`,
    [updatedName, updatedCategory, updatedDays, updatedRestock, upc]);
  res.json({ success: true });
}));

// 4b. Update inventory item's expiration date
app.put('/api/inventory/:id/expiration', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { expiration_date } = req.body;

  // Validate the date is a REAL calendar date (YYYY-MM-DD), or allow null to clear.
  // isValidCalendarDate rejects both bad formats (2026-99-99) and overflows (2026-02-30).
  if (expiration_date !== null && expiration_date !== undefined) {
    if (!isValidCalendarDate(expiration_date)) {
      return res.status(400).json({ error: "Invalid date. Use a real calendar date in YYYY-MM-DD format." });
    }
  }

  const result = await run(`UPDATE inventory SET expiration_date = ? WHERE id = ? AND consumed = 0`, 
    [expiration_date || null, id]);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Item not found or already consumed." });
  }
  res.json({ success: true });
}));

// 5. Consume by Name (Fuzzy match for Voice Assistants)
app.post('/api/consume_by_name', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });

  const escaped = escapeLike(name);
  const items = await query(`
    SELECT i.id, p.name, p.restock
    FROM inventory i
    JOIN products p ON i.upc = p.upc
    WHERE i.consumed = 0 AND p.name LIKE ? ESCAPE '\\'
    ORDER BY i.expiration_date ASC LIMIT 1
  `, [`%${escaped}%`]);

  if (items.length > 0) {
    await run(`UPDATE inventory SET consumed = 1, consumed_at = ? WHERE id = ?`, [nowIso(), items[0].id]);
    if (items[0].restock !== 0) {
      await addItemsToShoppingList(items[0].name);
      res.json({ success: true, message: `Consumed ${items[0].name}` });
    } else {
      res.json({ success: true, message: `Consumed ${items[0].name} (not restocked)` });
    }
  } else {
    res.status(404).json({ error: "No matching item found in inventory." });
  }
}));

// 6. Add by Name (Fuzzy match or create generic for Voice Assistants)
app.post('/api/add_by_name', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  if (tooLong(name)) return res.status(400).json({ error: `Name must be ${MAX_TEXT_LEN} characters or fewer.` });

  const escaped = escapeLike(name);
  let products = await query(`SELECT * FROM products WHERE name LIKE ? ESCAPE '\\' LIMIT 1`, [`%${escaped}%`]);
  let prod;

  if (products.length > 0) {
    prod = products[0]; // matched an existing product — no LLM call ran
  } else {
    const upc = 'generic_' + Date.now();
    const { days, llm_used } = await estimateShelfLife(name, "Generic");
    await run(`INSERT INTO products (upc, name, category, default_expiration_days, created_at) VALUES (?, ?, ?, ?, ?)`,
      [upc, name, "Generic", days, nowIso()]);
    prod = { upc, name, category: "Generic", default_expiration_days: days, llm_used };
  }

  const expirationDate = computeExpirationDate(prod.default_expiration_days);
  const inv = await addOrRefreshInventory(prod.upc, expirationDate);

  res.json({ success: true, message: inv.alreadyInStock ? `${prod.name} already in stock` : `Added ${prod.name}`, llm_used: prod.llm_used ?? false, id: inv.id, already_in_stock: inv.alreadyInStock });
}));

// --- Express Error Handler ---
// Catches errors thrown/rejected from asyncHandler-wrapped routes
app.use((err, req, res, _next) => {
  // Log the full error (with stack) server-side; return a generic message so we
  // don't leak SQL text or file paths to the client.
  log.error('Unhandled route error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// --- Background Task ---
async function checkExpiringItems() {
  try {
    const today = todayISO();
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = toLocalISODate(nextWeek);

    const expiring = await query(`
      SELECT i.id, p.name, i.expiration_date 
      FROM inventory i
      JOIN products p ON i.upc = p.upc
      WHERE i.consumed = 0 AND i.expiration_date <= ? AND i.expiration_date >= ?
    `, [nextWeekStr, today]);
    
    const count = expiring.length;
    const items = expiring.map(e => {
      const daysLeft = Math.ceil((new Date(e.expiration_date) - new Date(today)) / (1000 * 60 * 60 * 24));
      return { name: e.name, expiration_date: e.expiration_date, days_left: daysLeft };
    });

    await updateExpiringSensor(count, items);
  } catch (err) {
    log.error("Error in checkExpiringItems:", err.message);
  }
}

// --- Startup ---
let expiringInterval;
let purgeInterval;

initDb().then(() => {
  log.info("Database initialized");
  app.listen(port, () => {
    log.info(`Pantry Add-on server listening on port ${port}`);
    checkExpiringItems();
    purgeOldConsumed().catch(err => log.error("Purge error:", err.message));
    // Refresh the expiring-items sensor every 30 min so that a just-restarted HA
    // (whose API-pushed sensor was cleared on restart) repopulates promptly.
    expiringInterval = setInterval(checkExpiringItems, 1000 * 60 * 30);
    // Purge old consumed rows once a day.
    purgeInterval = setInterval(
      () => purgeOldConsumed().catch(err => log.error("Purge error:", err.message)),
      1000 * 60 * 60 * 24
    );
  });
}).catch(err => {
  log.error("Failed to initialize database", err);
  process.exit(1);
});

// --- Graceful Shutdown ---
async function shutdown(signal) {
  log.info(`\nReceived ${signal}. Shutting down gracefully...`);
  clearInterval(expiringInterval);
  clearInterval(purgeInterval);
  try {
    await closeDb();
  } catch {
    // Already logged inside closeDb
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
