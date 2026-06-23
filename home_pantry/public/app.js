let inventory = [];
let scanDebounceTimer = null;

// --- Helpers ---

/**
 * Create a text element safely (no innerHTML, no XSS).
 */
function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}

/**
 * Show a toast notification at the bottom of the screen.
 * Returns a reference to the toast element for manual removal.
 */
function showToast(message, duration = 0) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  // Trigger reflow then add visible class for CSS transition
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  if (duration > 0) {
    setTimeout(() => removeToast(toast), duration);
  }
  return toast;
}

function removeToast(toast) {
  if (toast && document.body.contains(toast)) {
    toast.classList.remove('toast-visible');
    setTimeout(() => {
      if (document.body.contains(toast)) document.body.removeChild(toast);
    }, 300);
  }
}

// --- Data Loading ---

async function loadInventory() {
  try {
    const res = await fetch('./api/inventory');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    inventory = await res.json();
    renderInventory();
    renderExpiring();
  } catch (err) {
    console.error("Failed to load inventory", err);
    showToast("Failed to load inventory.", 3000);
  }
}

// --- Rendering (XSS-safe: uses textContent, not innerHTML) ---

function renderInventory() {
  const list = document.getElementById('inventory-list');
  const search = document.getElementById('search').value.toLowerCase();
  const sort = document.getElementById('sort').value;

  let filtered = inventory.filter(item => item.name.toLowerCase().includes(search));

  filtered.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'category') return (a.category || '').localeCompare(b.category || '');
    if (sort === 'expiration') {
      if (!a.expiration_date) return 1;
      if (!b.expiration_date) return -1;
      return new Date(a.expiration_date) - new Date(b.expiration_date);
    }
    return 0;
  });

  list.innerHTML = '';

  if (filtered.length === 0) {
    const li = el('li', 'No items in inventory.', 'item');
    li.style.justifyContent = 'center';
    list.appendChild(li);
    return;
  }

  filtered.forEach(item => {
    const li = document.createElement('li');
    li.className = 'item';

    // Info section (safe text rendering)
    const info = document.createElement('div');
    info.className = 'item-info';

    info.appendChild(el('span', item.name, 'item-name'));

    const expStr = item.expiration_date ? `Exp: ${item.expiration_date}` : 'No expiration';
    info.appendChild(el('span', `${item.category || 'Uncategorized'} • ${expStr}`, 'item-meta'));

    // Actions section
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const editBtn = el('button', 'Edit');
    editBtn.addEventListener('click', () => editProduct(item.upc, item.name, item.category || '', item.default_expiration_days));
    actions.appendChild(editBtn);

    const expBtn = el('button', 'Set Exp');
    expBtn.title = 'Set expiration date';
    expBtn.addEventListener('click', () => editExpiration(item.id, item.expiration_date));
    actions.appendChild(expBtn);

    const mergeBtn = el('button', 'Merge');
    mergeBtn.addEventListener('click', () => mergeProduct(item.upc));
    actions.appendChild(mergeBtn);

    const consumeBtn = el('button', 'Consume');
    consumeBtn.className = 'btn-consume';
    consumeBtn.title = 'Consume and add to shopping list';
    consumeBtn.addEventListener('click', () => consumeItem(item.id));
    actions.appendChild(consumeBtn);

    const discardBtn = el('button', 'Discard');
    discardBtn.className = 'btn-discard';
    discardBtn.title = 'Discard without adding to shopping list';
    discardBtn.addEventListener('click', () => discardItem(item.id));
    actions.appendChild(discardBtn);

    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

function renderExpiring() {
  const list = document.getElementById('expiring-list');
  list.innerHTML = '';
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);

  // Filter: expiring within 7 days OR already expired (but NOT items expired more than 30 days ago — those are stale noise)
  const expiring = inventory.filter(i => {
    if (!i.expiration_date) return false;
    const d = new Date(i.expiration_date);
    d.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    return d <= nextWeek && d >= thirtyDaysAgo;
  }).sort((a, b) => new Date(a.expiration_date) - new Date(b.expiration_date));

  if (expiring.length === 0) {
    const li = el('li', 'Nothing expiring soon. 🎉', 'item');
    li.style.justifyContent = 'center';
    list.appendChild(li);
    return;
  }

  expiring.forEach(item => {
    const li = document.createElement('li');
    li.className = 'item';

    const info = document.createElement('div');
    info.className = 'item-info';
    info.appendChild(el('span', item.name, 'item-name'));

    const d = new Date(item.expiration_date);
    d.setHours(0, 0, 0, 0);
    const cls = d < today ? 'expired' : 'expiring';
    const label = d < today ? `EXPIRED: ${item.expiration_date}` : `Exp: ${item.expiration_date}`;
    info.appendChild(el('span', label, `item-meta ${cls}`));

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const consumeBtn = el('button', 'Consume');
    consumeBtn.className = 'btn-consume';
    consumeBtn.addEventListener('click', () => consumeItem(item.id));
    actions.appendChild(consumeBtn);

    const discardBtn = el('button', 'Discard');
    discardBtn.className = 'btn-discard';
    discardBtn.addEventListener('click', () => discardItem(item.id));
    actions.appendChild(discardBtn);

    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

// --- Actions ---

async function consumeItem(id) {
  if (!confirm("Consume this item and add it to your shopping list?")) return;
  try {
    const res = await fetch('./api/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    showToast(data.message || 'Item consumed.', 3000);
    loadInventory();
  } catch (err) {
    showToast("Failed to consume item: " + err.message, 4000);
  }
}

async function discardItem(id) {
  if (!confirm("Discard this item? It will NOT be added to your shopping list.")) return;
  try {
    const res = await fetch('./api/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    showToast(data.message || 'Item discarded.', 3000);
    loadInventory();
  } catch (err) {
    showToast("Failed to discard item: " + err.message, 4000);
  }
}

async function editProduct(upc, oldName, oldCategory, oldDays) {
  const name = prompt("Edit product name:", oldName);
  if (name === null) return; // cancelled
  const category = prompt("Edit category:", oldCategory);
  if (category === null) return;
  const daysStr = prompt("Default shelf life (days, 0 for non-perishable):", oldDays != null ? String(oldDays) : '14');
  if (daysStr === null) return;
  
  const body = { name: name || oldName, category: category || oldCategory };
  const parsedDays = parseInt(daysStr, 10);
  if (!isNaN(parsedDays)) {
    body.default_expiration_days = parsedDays;
  }

  try {
    const res = await fetch(`./api/products/${encodeURIComponent(upc)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    showToast('Product updated.', 3000);
    loadInventory();
  } catch (err) {
    showToast("Failed to edit product: " + err.message, 4000);
  }
}

async function editExpiration(id, currentDate) {
  const newDate = prompt("Set expiration date (YYYY-MM-DD), or leave blank to clear:", currentDate || '');
  if (newDate === null) return; // cancelled

  // Basic client-side validation
  if (newDate && !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    showToast("Invalid date format. Use YYYY-MM-DD.", 4000);
    return;
  }

  try {
    const res = await fetch(`./api/inventory/${id}/expiration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiration_date: newDate || null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    showToast('Expiration date updated.', 3000);
    loadInventory();
  } catch (err) {
    showToast("Failed to update expiration: " + err.message, 4000);
  }
}

async function mergeProduct(sourceUpc) {
  const targetUpc = prompt("Enter the UPC barcode you want to merge THIS item into (all inventory will be transferred to the target UPC):");
  if (!targetUpc || targetUpc === sourceUpc) return;
  
  if (!confirm(`Are you sure you want to merge this product into UPC ${targetUpc}?`)) return;

  try {
    const res = await fetch(`./api/merge_products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_upc: sourceUpc, target_upc: targetUpc })
    });
    const data = await res.json();
    if (data.success) {
      showToast("Merge successful!", 3000);
      loadInventory();
    } else {
      showToast("Merge failed: " + data.error, 4000);
    }
  } catch (err) {
    showToast("Failed to merge product: " + err.message, 4000);
  }
}

// --- Scanner ---

const modal = document.getElementById('scanner-modal');
const btnScan = document.getElementById('btn-scan');
const btnCloseScanner = document.getElementById('btn-close-scanner');
const btnHaScanner = document.getElementById('btn-ha-scanner');
let html5QrcodeScanner;

// Safely tear down any existing scanner instance. clear() returns a promise,
// so we await it to avoid leaking/double-rendering a reader on reopen.
async function teardownScanner() {
  if (!html5QrcodeScanner) return;
  try {
    await html5QrcodeScanner.clear();
  } catch (err) {
    console.warn('Scanner teardown failed:', err);
  }
  html5QrcodeScanner = null;
}

btnScan.addEventListener('click', async () => {
  if (typeof Html5QrcodeScanner === 'undefined') {
    showToast('Barcode scanner failed to load. Reload the page and try again.', 4000);
    return;
  }
  await teardownScanner(); // ensure no previous instance is still rendered
  modal.classList.remove('hidden');
  html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
  html5QrcodeScanner.render(onScanSuccess, onScanFailure);
});

btnCloseScanner.addEventListener('click', async () => {
  modal.classList.add('hidden');
  await teardownScanner();
});

btnHaScanner.addEventListener('click', () => {
  showToast("To use the native scanner, configure an HA Action that triggers the 'mobile_app.barcode_scanned' event.", 5000);
});

async function onScanSuccess(decodedText, decodedResult) {
  // Debounce: ignore rapid duplicate scans from the continuous scanner.
  if (scanDebounceTimer) return;
  scanDebounceTimer = setTimeout(() => { scanDebounceTimer = null; }, 2000);

  await teardownScanner();
  modal.classList.add('hidden');

  const toast = showToast(`Looking up UPC: ${decodedText}...`);

  try {
    const res = await fetch('./api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upc: decodedText })
    });
    const data = await res.json();
    
    removeToast(toast);

    if (data.success) {
      const expLabel = data.expiration_date || 'N/A';
      const llmNote = data.llm_used === false ? ' — default, LLM unavailable' : '';
      showToast(`Added: ${data.product.name} (Exp: ${expLabel}${llmNote})`, 4000);
      loadInventory();
    } else if (data.needs_info) {
      const name = prompt("Unknown barcode! What is the name of this product?");
      if (name) {
        const category = prompt("What category is it? (e.g. Dairy, Cleaning, Snacks)", "Misc");
        
        const toast2 = showToast("Estimating expiration date...");

        const customRes = await fetch('./api/scan_custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upc: data.upc, name, category })
        });
        const customData = await customRes.json();
        removeToast(toast2);

        if (customData.success) {
          const expLabel = customData.expiration_date || 'N/A';
          const llmNote = customData.llm_used === false ? ' — default, LLM unavailable' : '';
          showToast(`Added: ${customData.product.name} (Exp: ${expLabel}${llmNote})`, 4000);
          loadInventory();
        } else {
          showToast("Error adding item: " + customData.error, 4000);
        }
      }
    } else {
      showToast("Error: " + (data.error || 'Unknown error'), 4000);
    }
  } catch (err) {
    removeToast(toast);
    // Allow an immediate retry after a failed scan rather than waiting out the debounce.
    clearTimeout(scanDebounceTimer);
    scanDebounceTimer = null;
    showToast("Scan request failed: " + err.message, 4000);
  }
}

function onScanFailure(error) {
  // Silent ignore for continuous scanning
}

// --- Event Listeners ---
document.getElementById('search').addEventListener('input', renderInventory);
document.getElementById('sort').addEventListener('change', renderInventory);

// Initial load
loadInventory();
