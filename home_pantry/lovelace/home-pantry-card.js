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

// External-bus message ids. Start high to avoid colliding with the frontend's
// own low, incrementing ids.
let msgId = 100000;

// Whichever external-bus transport the Companion app injected (one exists per
// platform; none in a desktop browser).
function busSender() {
  if (window.externalAppV2 && typeof window.externalAppV2.postMessage === 'function') {
    return (json) => window.externalAppV2.postMessage(json); // Android (v2)
  }
  if (window.externalApp && typeof window.externalApp.externalBus === 'function') {
    return (json) => window.externalApp.externalBus(json);   // Android (v1)
  }
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.externalBus) {
    return (json) => window.webkit.messageHandlers.externalBus.postMessage(json); // iOS
  }
  return null;
}

// Send a {id, type, payload} message to the app as a JSON string. Returns false
// when there's no external bus (i.e. not running inside the Companion app).
function sendToApp(message) {
  const send = busSender();
  if (!send) return false;
  try {
    send(JSON.stringify(message));
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
        data_key: 'upc',
        scan_title: 'Scan a barcode',
        scan_description: 'Point the camera at a product barcode',
        cancel_label: 'Done',
      },
      config || {}
    );
    this._activeId = null;
    this._count = 0;
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
    this._card.appendChild(body);
    this.appendChild(this._card);
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
    this._activeId = ++msgId;
    const ok = sendToApp({
      id: this._activeId,
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
    if (!ok) this._activeId = null;
  }

  // Observe incoming app->frontend messages by wrapping window.externalBus, while
  // always forwarding to the frontend's own handler. Installed for the card's
  // lifetime; it only acts while a scan session is active (_activeId set).
  _installReceiver() {
    if (this._wrapped) return;
    const original = typeof window.externalBus === 'function' ? window.externalBus : null;
    this._origExternalBus = original;
    const self = this;
    this._wrapper = function (message) {
      try {
        const data = typeof message === 'string' ? JSON.parse(message) : message;
        self._onAppMessage(data);
      } catch (e) { /* not parseable / not for us */ }
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

  async _onAppMessage(data) {
    if (!data || this._activeId == null) return;                 // only during an active scan
    if (data.id != null && data.id !== this._activeId) return;   // ignore other sessions
    if (data.type === RESULT_TYPE) {
      const value = data.payload && data.payload.rawValue;
      if (value) await this._handleScan(String(value));
    } else if (data.type === ABORTED_TYPE) {
      this._finishSession();
    }
  }

  async _handleScan(value) {
    let message;
    try {
      const content = await this._sendToPantry(value);
      this._count++;
      if (content && content.success && content.product && content.product.name) {
        const exp = content.expiration_date ? ` (exp ${content.expiration_date})` : '';
        message = `Added ${content.product.name}${exp}`;
      } else if (content && content.needs_info) {
        message = `Unknown barcode ${value} — open Home Pantry to add details`;
      } else {
        message = `Sent ${value} to Home Pantry`;
      }
    } catch (e) {
      message = `Failed to send ${value}: ${(e && e.message) || e}`;
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
    this._activeId = null;
    this._setStatus(n > 0
      ? `Done — ${n} item${n === 1 ? '' : 's'} sent to Home Pantry.`
      : 'Scan canceled.');
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
