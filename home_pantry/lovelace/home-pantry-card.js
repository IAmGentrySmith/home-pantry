/**
 * Home Pantry — Scan card for Home Assistant dashboards.
 *
 * Unlike the add-on's own UI (which runs in an ingress <iframe> and cannot reach
 * the Companion app's native scanner), this card runs in the MAIN Home Assistant
 * frontend, so it has access to the app's "external bus". It opens the native
 * barcode scanner and hands each scanned code to a Home Assistant service
 * (default `rest_command.pantry_scan`), which POSTs it to the Home Pantry add-on
 * server-side — no HTTPS/CORS requirement in the browser.
 *
 * Install:
 *   1. Copy this file to  <config>/www/home-pantry-card.js
 *   2. Settings > Dashboards > (⋮) > Resources > Add:
 *        URL  /local/home-pantry-card.js   Type  JavaScript Module
 *   3. Add a card:  type: custom:home-pantry-scan-card
 *
 * See the repository README ("Native barcode scanner on a dashboard") for the
 * rest_command and a sample dashboard view.
 */

const SCAN_TYPE = 'bar_code/scan';
const NOTIFY_TYPE = 'bar_code/notify';
const RESULT_TYPE = 'bar_code/scan_result';
const ABORTED_TYPE = 'bar_code/aborted';

// Holding the scanner on a barcode fires the same result repeatedly; ignore an
// identical value seen again within this window so it isn't submitted twice.
const DUPLICATE_WINDOW_MS = 3000;

// External-bus message ids. Start high to avoid colliding with the frontend's
// own low, incrementing ids.
let msgId = 100000;

// Whichever external-bus transport the Companion app injected (one exists per
// platform; none in a desktop browser). Each transport serializes differently,
// and this MUST match Home Assistant's own _sendExternal: Android gets a JSON
// string, but iOS (webkit) gets the RAW object (WKWebView serializes it). A
// stringified message to iOS is silently dropped — the scanner never opens.
function busSender() {
  if (window.externalAppV2 && typeof window.externalAppV2.postMessage === 'function') {
    // Android (v2): bare message wrapped in an envelope, as a JSON string.
    return (msg) => window.externalAppV2.postMessage(JSON.stringify({ type: 'externalBus', payload: msg }));
  }
  if (window.externalApp && typeof window.externalApp.externalBus === 'function') {
    // Android (legacy): bare message, as a JSON string.
    return (msg) => window.externalApp.externalBus(JSON.stringify(msg));
  }
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.externalBus) {
    // iOS: the raw object, NOT a JSON string.
    return (msg) => window.webkit.messageHandlers.externalBus.postMessage(msg);
  }
  return null;
}

// Send a {id, type, payload} message to the app. Returns false when there's no
// external bus (i.e. not running inside the Companion app).
function sendToApp(message) {
  const send = busSender();
  if (!send) return false;
  try {
    send(message);
    return true;
  } catch (e) {
    return false;
  }
}

class HomePantryScanCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign(
      {
        title: 'Scan to Pantry',
        service: 'rest_command.pantry_scan',
        consume_service: 'rest_command.pantry_consume',
        data_key: 'upc',
        scan_title: 'Scan a barcode',
        scan_description: 'Point the camera at a product barcode',
        cancel_label: 'Done',
      },
      config || {}
    );
    this._scanning = false;
    this._count = 0;
    this._lastValue = null;
    this._lastValueTime = 0;
    this._recent = this._recent || []; // preserve across config changes
    this._build();
  }

  set hass(hass) { this._hass = hass; }

  getCardSize() { return 3; }

  connectedCallback() { this._installReceiver(); this._reflectAvailability(); }
  disconnectedCallback() { this._removeReceiver(); }

  _build() {
    if (this._card) return;
    this._card = document.createElement('ha-card');
    this._card.header = this._config.title;

    const body = document.createElement('div');
    body.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:12px;';

    this._btn = document.createElement('button');
    this._btn.textContent = 'Scan barcode';
    this._btn.style.cssText =
      'padding:12px 16px;font-size:16px;border:none;border-radius:8px;' +
      'background:var(--primary-color);color:var(--text-primary-color,#fff);cursor:pointer;';
    this._btn.addEventListener('click', () => this._startScan());

    this._status = document.createElement('div');
    this._status.style.cssText = 'font-size:14px;color:var(--secondary-text-color);min-height:1.2em;';

    body.appendChild(this._btn);
    body.appendChild(this._status);

    this._recentEl = document.createElement('div');
    this._recentEl.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    body.appendChild(this._recentEl);

    this._card.appendChild(body);
    this.appendChild(this._card);
    this._renderRecent();
    this._reflectAvailability();
  }

  _reflectAvailability() {
    if (!this._btn) return;
    if (busSender()) {
      this._btn.disabled = false;
      if (!this._status.textContent) this._setStatus('Ready.');
    } else {
      this._btn.disabled = true;
      this._setStatus('Open this dashboard in the Home Assistant Companion app to use the native scanner.');
    }
  }

  _setStatus(text) { if (this._status) this._status.textContent = text; }

  _startScan() {
    if (!busSender()) { this._reflectAvailability(); return; }
    this._count = 0;
    this._scanning = true;
    this._lastValue = null; // fresh session: allow the same item to be added again
    const ok = sendToApp({
      id: ++msgId,
      type: SCAN_TYPE,
      payload: {
        title: this._config.scan_title,
        description: this._config.scan_description,
        alternative_option_label: this._config.cancel_label,
      },
    });
    this._setStatus(ok
      ? `Scanner open — scan items, then tap “${this._config.cancel_label}”.`
      : 'Could not open the scanner.');
    if (!ok) this._scanning = false;
  }

  // Observe incoming app->frontend messages by wrapping window.externalBus.
  // Scan results arrive as external-bus *commands*:
  //   { id, type: "command", command: "bar_code/scan_result" | "bar_code/aborted", payload }
  // We handle OUR commands and don't forward them (forwarding makes HA log
  // "Unknown command" and send the app an error ack); everything else passes
  // through to the frontend's own handler untouched. Installed for the card's
  // lifetime; it only acts while a scan session is active.
  _installReceiver() {
    if (this._wrapped) return;
    const original = typeof window.externalBus === 'function' ? window.externalBus : null;
    this._origExternalBus = original;
    const self = this;
    this._wrapper = function (message) {
      let data = null;
      try { data = typeof message === 'string' ? JSON.parse(message) : message; } catch (e) { /* ignore */ }
      if (self._scanning && data && data.type === 'command' &&
          (data.command === RESULT_TYPE || data.command === ABORTED_TYPE)) {
        self._onAppMessage(data);
        return; // ours — handled; do not forward
      }
      if (original) return original.apply(window, arguments);
    };
    window.externalBus = this._wrapper;
    this._wrapped = true;
  }

  _removeReceiver() {
    if (!this._wrapped) return;
    // Only restore if nothing wrapped us in turn, so we don't clobber another
    // listener installed after this card.
    if (window.externalBus === this._wrapper) {
      window.externalBus = this._origExternalBus || undefined;
    }
    this._wrapped = false;
  }

  // `data` is an external-bus command: { type: "command", command, payload }.
  // The command's id is the app's own (NOT our scan request's), so we must not
  // filter by id — we gate on the active scan session instead. The discriminator
  // is `command`, not `type` (`type` is always "command" for incoming commands).
  _onAppMessage(data) {
    if (!this._scanning) return;
    if (data.command === RESULT_TYPE) {
      const value = data.payload && data.payload.rawValue;
      if (!value) return;
      const v = String(value);
      const now = Date.now();
      // De-dupe: skip an identical value repeated within the window (holding the
      // scanner on one barcode). A different value, or the same after the window,
      // is accepted — so two of the same item can still be added deliberately.
      if (v === this._lastValue && now - this._lastValueTime < DUPLICATE_WINDOW_MS) return;
      this._lastValue = v;
      this._lastValueTime = now;
      this._handleScan(v); // async; handles its own errors
    } else if (data.command === ABORTED_TYPE) {
      this._finishSession();
    }
  }

  async _handleScan(value) {
    let message;
    try {
      const content = await this._sendToPantry(value);
      this._count++;
      if (content && content.success && content.product && content.product.name) {
        const verb = content.already_in_stock ? 'Already in stock' : 'Added';
        const exp = content.expiration_date ? ` (exp ${content.expiration_date})` : '';
        message = `✓ ${verb}: ${content.product.name}${exp}`;
        // Track on the card's recent list so it can be consumed without leaving
        // the dashboard. Needs the inventory id (requires HA service responses).
        if (content.id != null) this._addRecent(content.product.name, content.id);
      } else if (content && content.needs_info) {
        message = `⚠️ Unknown barcode — finish in the Home Pantry app`;
      } else {
        message = `✓ Sent ${value} to Home Pantry`;
      }
    } catch (e) {
      message = `✕ Failed: ${(e && e.message) || e}`;
    }
    this._setStatus(`${message} — ${this._count} sent this session`);
    // Best-effort feedback inside the scanner overlay (ignored if unsupported).
    sendToApp({ id: ++msgId, type: NOTIFY_TYPE, payload: { message } });
  }

  async _sendToPantry(value) {
    if (!this._hass) throw new Error('Home Assistant not ready');
    const parts = (this._config.service || 'rest_command.pantry_scan').split('.');
    const domain = parts[0];
    const service = parts.slice(1).join('.');
    const data = { [this._config.data_key || 'upc']: value };
    try {
      // Request the service response so we can show the product name. On older HA
      // (no service responses) this just returns a context object → we degrade.
      const resp = await this._hass.callService(domain, service, data, undefined, false, true);
      const content = resp && resp.response && resp.response.content;
      return content && typeof content === 'object' ? content : null;
    } catch (e) {
      // Retry without requesting a response, then report unknown (still added).
      await this._hass.callService(domain, service, data);
      return null;
    }
  }

  _finishSession() {
    const n = this._count;
    this._scanning = false;
    this._setStatus(n > 0
      ? `Done — ${n} item${n === 1 ? '' : 's'} sent to Home Pantry.`
      : 'Scan canceled.');
  }

  // --- Recent items (scan → verify → consume, all on the dashboard) ---

  _addRecent(name, id) {
    if (this._recent.some(r => r.id === id)) return; // a re-scan refreshes the same row
    this._recent.unshift({ name, id, consumed: false });
    if (this._recent.length > 20) this._recent.length = 20;
    this._renderRecent();
  }

  _renderRecent() {
    if (!this._recentEl) return;
    this._recentEl.textContent = '';
    if (!this._recent || this._recent.length === 0) return;

    const heading = document.createElement('div');
    heading.textContent = 'Scanned this session';
    heading.style.cssText = 'font-size:12px;color:var(--secondary-text-color);margin:6px 0 2px;';
    this._recentEl.appendChild(heading);

    for (const item of this._recent) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;' +
        'border-bottom:1px solid var(--divider-color, rgba(127,127,127,0.2));';

      const label = document.createElement('span');
      label.textContent = item.name;
      label.style.cssText =
        'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        (item.consumed ? 'text-decoration:line-through;opacity:0.6;' : '');

      const btn = document.createElement('button');
      btn.textContent = item.consumed ? 'Consumed' : 'Consume';
      btn.disabled = !!item.consumed;
      btn.style.cssText =
        'flex:none;padding:4px 10px;border:1px solid var(--primary-color);border-radius:6px;' +
        'background:transparent;color:var(--primary-color);cursor:pointer;font-size:13px;';
      btn.addEventListener('click', () => this._consume(item, btn, label));

      row.appendChild(label);
      row.appendChild(btn);
      this._recentEl.appendChild(row);
    }
  }

  // Consume is fire-and-forget via the configured service (default
  // rest_command.pantry_consume), so it works without HTTPS/CORS like the scan.
  async _consume(item, btn, label) {
    if (!this._hass) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const parts = (this._config.consume_service || 'rest_command.pantry_consume').split('.');
      await this._hass.callService(parts[0], parts.slice(1).join('.'), { id: item.id });
      item.consumed = true;
      btn.textContent = 'Consumed';
      label.style.textDecoration = 'line-through';
      label.style.opacity = '0.6';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Consume';
      this._setStatus(`✕ Consume failed: ${(e && e.message) || e}`);
    }
  }
}

customElements.define('home-pantry-scan-card', HomePantryScanCard);

// Surface the card in the dashboard "Add card" picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'home-pantry-scan-card',
  name: 'Home Pantry Scan',
  description: "Scan barcodes with the Companion app's native scanner and add them to Home Pantry.",
});
