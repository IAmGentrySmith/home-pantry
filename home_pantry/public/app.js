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

// --- Dialogs (accessible replacements for native prompt()/confirm()) ---

const formDialog = document.getElementById('form-dialog');

/**
 * Show a modal dialog with optional input fields. Uses the native <dialog>
 * element, which provides focus trapping, Escape-to-close and a backdrop.
 * Resolves to an object of field values keyed by name, or null if cancelled.
 */
function showDialog({ title, message = '', fields = [], submitText = 'Save', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    formDialog.innerHTML = '';
    const form = document.createElement('form');

    form.appendChild(el('h2', title, 'dialog-title'));
    if (message) form.appendChild(el('p', message, 'dialog-message'));

    const inputs = [];
    fields.forEach((f, i) => {
      const id = `dlg-field-${i}`;
      const input = document.createElement('input');
      input.id = id;
      input.name = f.name;
      input.type = f.type || 'text';

      if (f.type === 'checkbox') {
        // Checkbox sits inline with its label and returns a boolean on submit.
        input.checked = !!f.value;
        const wrap = el('div', null, 'dialog-field dialog-field-check');
        const label = el('label', f.label, 'dialog-label');
        label.htmlFor = id;
        wrap.appendChild(input);
        wrap.appendChild(label);
        form.appendChild(wrap);
        inputs.push(input);
        return;
      }

      const wrap = el('div', null, 'dialog-field');
      const label = el('label', f.label, 'dialog-label');
      label.htmlFor = id;
      if (f.value != null) input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.required) input.required = true;
      if (f.min != null) input.min = f.min;
      input.className = 'dialog-input';
      wrap.appendChild(label);
      wrap.appendChild(input);
      form.appendChild(wrap);
      inputs.push(input);
    });

    const actions = el('div', null, 'dialog-actions');
    const cancelBtn = el('button', cancelText, 'secondary-btn');
    cancelBtn.type = 'button';
    const submitBtn = el('button', submitText, danger ? 'primary-btn danger-btn' : 'primary-btn');
    submitBtn.type = 'submit';
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      formDialog.removeEventListener('close', onClose);
      if (formDialog.open) formDialog.close();
      resolve(result);
    };
    const onClose = () => finish(null); // Escape key / backdrop

    cancelBtn.addEventListener('click', () => finish(null));
    form.addEventListener('submit', (e) => {
      e.preventDefault(); // native required-field validation still runs first
      const values = {};
      inputs.forEach((inp) => {
        values[inp.name] = inp.type === 'checkbox' ? inp.checked : inp.value;
      });
      finish(values);
    });
    formDialog.addEventListener('close', onClose);

    formDialog.appendChild(form);
    formDialog.showModal();
    if (inputs[0]) inputs[0].focus();
  });
}

/** Yes/no confirmation dialog. Resolves true if confirmed. */
async function showConfirm({ title, message, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
  const result = await showDialog({ title, message, fields: [], submitText: confirmText, cancelText, danger });
  return result !== null;
}

// --- API token generator ---
// Home Assistant renders the add-on Configuration page, so we can't add a button
// there. Instead we generate the token here; the user copies it into
// Configuration > "Voice API token". crypto.getRandomValues works without a
// secure context (unlike crypto.subtle / navigator.clipboard).
function generateApiToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function copyFromInput(input) {
  input.focus();
  input.select();
  try { input.setSelectionRange(0, input.value.length); } catch (e) { /* not selectable */ }
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(input.value);
      return true;
    }
  } catch (e) { /* fall through to execCommand */ }
  try { if (document.execCommand('copy')) return true; } catch (e) { /* unsupported */ }
  return false; // text is left selected; user copies manually
}

function showApiTokenDialog() {
  formDialog.innerHTML = '';
  const form = document.createElement('form');
  form.method = 'dialog'; // the "Close" submit button closes the native <dialog>

  form.appendChild(el('h2', 'API token', 'dialog-title'));
  form.appendChild(el('p',
    'Protects the optional direct API used by the Voice Assistant commands and the dashboard scan card. ' +
    'Copy this token into the add-on’s Configuration → “Voice API token”, then Save and Restart the add-on. ' +
    'If you change it later, update your rest_commands to match.',
    'dialog-message'));

  const row = el('div', null, 'token-row');
  const input = document.createElement('input');
  input.className = 'dialog-input token-input';
  input.readOnly = true;
  input.value = generateApiToken();
  input.setAttribute('aria-label', 'Generated API token');
  const copyBtn = el('button', 'Copy', 'secondary-btn');
  copyBtn.type = 'button';
  row.appendChild(input);
  row.appendChild(copyBtn);
  form.appendChild(row);

  const status = el('div', '', 'dialog-label');
  form.appendChild(status);

  const actions = el('div', null, 'dialog-actions');
  const regenBtn = el('button', 'Regenerate', 'secondary-btn');
  regenBtn.type = 'button';
  const closeBtn = el('button', 'Close', 'primary-btn');
  closeBtn.type = 'submit';
  actions.appendChild(regenBtn);
  actions.appendChild(closeBtn);
  form.appendChild(actions);

  copyBtn.addEventListener('click', async () => {
    status.textContent = (await copyFromInput(input))
      ? 'Copied to clipboard.'
      : 'Selected — press Ctrl/Cmd+C (or long-press) to copy.';
  });
  regenBtn.addEventListener('click', () => {
    input.value = generateApiToken();
    status.textContent = 'New token generated.';
  });

  formDialog.appendChild(form);
  formDialog.showModal();
  input.focus();
  input.select();
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

    // Surface the "don't restock" preference so it's visible at a glance.
    if (item.restock === 0) {
      info.appendChild(el('span', 'Not restocked when used up', 'item-flag'));
    }

    // Actions section
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const editBtn = el('button', 'Edit');
    editBtn.addEventListener('click', () => editProduct(item.upc, item.name, item.category || '', item.default_expiration_days, item.restock));
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
  const item = inventory.find(i => i.id === id);
  const noRestock = item && item.restock === 0;
  if (!(await showConfirm({
    title: 'Consume item',
    message: noRestock
      ? 'Consume this item? It’s marked “not restocked”, so it will NOT be added to your shopping list.'
      : 'Consume this item and add it to your shopping list?',
    confirmText: 'Consume',
  }))) return;
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
  if (!(await showConfirm({
    title: 'Discard item',
    message: 'Discard this item? It will NOT be added to your shopping list.',
    confirmText: 'Discard',
    danger: true,
  }))) return;
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

async function editProduct(upc, oldName, oldCategory, oldDays, oldRestock) {
  const result = await showDialog({
    title: 'Edit product',
    fields: [
      { name: 'name', label: 'Product name', type: 'text', value: oldName, required: true },
      { name: 'category', label: 'Category', type: 'text', value: oldCategory },
      { name: 'days', label: 'Default shelf life (days, 0 = non-perishable)', type: 'number', min: 0, value: oldDays != null ? String(oldDays) : '14' },
      { name: 'restock', label: 'Add to shopping list when used up', type: 'checkbox', value: oldRestock !== 0 },
    ],
    submitText: 'Save',
  });
  if (!result) return; // cancelled

  const body = { name: result.name || oldName, category: result.category || oldCategory, restock: result.restock ? 1 : 0 };
  const parsedDays = parseInt(result.days, 10);
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
  const result = await showDialog({
    title: 'Set expiration date',
    message: 'Leave blank to clear the expiration date.',
    fields: [{ name: 'date', label: 'Expiration date', type: 'date', value: currentDate || '' }],
    submitText: 'Save',
  });
  if (!result) return; // cancelled

  const newDate = (result.date || '').trim();
  // A native date input already yields YYYY-MM-DD, but validate defensively.
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
  const result = await showDialog({
    title: 'Merge product',
    message: 'Transfer all inventory of THIS item onto another product. Enter the target product’s UPC barcode; this item then becomes an alias of it.',
    fields: [{ name: 'target', label: 'Target UPC barcode', type: 'text', required: true, placeholder: 'e.g. 0123456789012' }],
    submitText: 'Merge',
    danger: true,
  });
  if (!result) return; // cancelled

  const targetUpc = (result.target || '').trim();
  if (!targetUpc || targetUpc === sourceUpc) return;

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

async function addManual() {
  const result = await showDialog({
    title: 'Add item manually',
    message: 'Add an item without scanning a barcode.',
    fields: [
      { name: 'name', label: 'Item name', type: 'text', required: true, placeholder: 'e.g. Salmon fillet' },
      { name: 'category', label: 'Category', type: 'text', value: 'Misc' },
      { name: 'expiration', label: 'Expiration date (optional — blank lets the estimator decide)', type: 'date' },
      { name: 'restock', label: 'Add to shopping list when used up', type: 'checkbox', value: true },
    ],
    submitText: 'Add',
  });
  if (!result) return; // cancelled

  const name = (result.name || '').trim();
  if (!name) return;

  const toast = showToast('Adding item…');
  try {
    const res = await fetch('./api/add_manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category: (result.category || '').trim() || 'Misc',
        expiration_date: (result.expiration || '').trim() || null,
        restock: result.restock ? 1 : 0,
      }),
    });
    const data = await res.json();
    removeToast(toast);
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    const expLabel = data.expiration_date || 'N/A';
    showToast(`Added: ${data.product.name} (Exp: ${expLabel})`, 4000);
    loadInventory();
  } catch (err) {
    removeToast(toast);
    showToast('Failed to add item: ' + err.message, 4000);
  }
}

// --- Scanner ---

const modal = document.getElementById('scanner-modal');
const btnScan = document.getElementById('btn-scan');
const btnCloseScanner = document.getElementById('btn-close-scanner');
const btnPhotoScan = document.getElementById('btn-photo-scan');
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

// Photo-based fallback. The live camera (getUserMedia) requires a secure
// context, which a local http:// Home Assistant — common in the mobile app — is
// not, so it's blocked there. Decoding a still image with Html5Qrcode.scanFile()
// uses no camera stream and therefore works regardless. The hidden file input
// lets iOS/Android offer "Take Photo" or "Photo Library".
const photoInput = document.createElement('input');
photoInput.type = 'file';
photoInput.accept = 'image/*';
photoInput.hidden = true;
document.body.appendChild(photoInput);

btnPhotoScan.addEventListener('click', () => photoInput.click());

// Restricting to the retail symbologies we actually care about makes ZXing
// focus instead of trying every format — it measurably improves 1D reads.
function retailFormats() {
  if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
  const F = Html5QrcodeSupportedFormats;
  return [F.UPC_A, F.UPC_E, F.EAN_13, F.EAN_8, F.CODE_128, F.QR_CODE];
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

// Center-crop + downscale to a File. Barcodes are wide and users centre them,
// so a central band makes the code large relative to ZXing's scan lines.
// scanFile() requires a File (not a bare Blob), so we wrap the canvas output.
function cropToFile(img, fracW, fracH, maxW) {
  return new Promise((resolve) => {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return resolve(null);
    const sw = Math.round(iw * fracW);
    const sh = Math.round(ih * fracH);
    const sx = Math.round((iw - sw) / 2);
    const sy = Math.round((ih - sh) / 2);
    const scale = Math.min(1, maxW / sw); // never upscale
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    canvas.toBlob(
      (blob) => resolve(blob ? new File([blob], 'crop.png', { type: 'image/png' }) : null),
      'image/png'
    );
  });
}

// A linear barcode is often too small in a full-resolution phone photo for a
// single-shot decode. Try progressively tighter centre crops first (best for
// 1D), then the original image last (covers QR / already-tight shots). First
// successful decode wins.
async function buildScanCandidates(file) {
  const processed = [];
  try {
    const { img, url } = await loadImageFromFile(file);
    const crops = [[0.85, 0.55, 1600], [0.6, 0.4, 1280], [1.0, 1.0, 1600]];
    for (const [fw, fh, maxW] of crops) {
      const f = await cropToFile(img, fw, fh, maxW);
      if (f) processed.push(f);
    }
    URL.revokeObjectURL(url);
  } catch (err) {
    // Couldn't process the image — fall back to the original file alone.
  }
  return [...processed, file];
}

async function decodeBarcodeFromFile(file) {
  const formats = retailFormats();
  const config = {
    verbose: false,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }, // native decoder on Android/desktop; no-op on iOS
  };
  if (formats) config.formatsToSupport = formats;

  for (const candidate of await buildScanCandidates(file)) {
    let reader;
    try {
      reader = new Html5Qrcode('reader', config);
      const decoded = await reader.scanFile(candidate, /* showImage */ false);
      if (decoded) return decoded;
    } catch (err) {
      // This candidate didn't decode; try the next.
    } finally {
      if (reader) { try { await reader.clear(); } catch (e) { /* nothing to clear */ } }
    }
  }
  return null;
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files && photoInput.files[0];
  photoInput.value = ''; // reset so the same photo can be picked again later
  if (!file) return;
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Barcode scanner failed to load. Reload the page and try again.', 4000);
    return;
  }

  await teardownScanner(); // release the live reader if it was running
  const toast = showToast('Decoding barcode from photo…');
  try {
    const decodedText = await decodeBarcodeFromFile(file);
    removeToast(toast);
    if (decodedText) {
      await onScanSuccess(decodedText);
    } else {
      showToast('No barcode found. Get closer so the barcode fills the frame, keep it level and in focus, then retry — or use “+ Add” to enter it by hand.', 6000);
    }
  } catch (err) {
    removeToast(toast);
    showToast('Could not read that photo. Try again, or use “+ Add” to enter the item by hand.', 5000);
  }
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
      const info = await showDialog({
        title: 'Unknown barcode',
        message: `Barcode ${data.upc} isn't in Open Food Facts. Add it manually:`,
        fields: [
          { name: 'name', label: 'Product name', type: 'text', required: true },
          { name: 'category', label: 'Category', type: 'text', value: 'Misc' },
        ],
        submitText: 'Add',
      });
      if (info && info.name) {
        const toast2 = showToast("Estimating expiration date...");

        const customRes = await fetch('./api/scan_custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upc: data.upc, name: info.name, category: info.category })
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
document.getElementById('btn-api-token').addEventListener('click', showApiTokenDialog);
document.getElementById('btn-add').addEventListener('click', addManual);
document.getElementById('search').addEventListener('input', renderInventory);
document.getElementById('sort').addEventListener('change', renderInventory);

// Initial load
loadInventory();
