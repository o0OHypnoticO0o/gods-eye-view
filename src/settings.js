/**
 * Settings panel manager — fetches API/service configuration from the
 * server-side /api/settings endpoint and renders an editable panel.
 *
 * Settings are persisted server-side to ~/.gods-eye-view/settings.json
 * and merged with .env fallbacks. Sensitive keys are masked in GET responses.
 *
 * @module settings
 */

const SETTINGS_API = '/api/settings';

/** Tier display order. */
const TIER_ORDER = ['core', 'inference', 'voice', 'layers', 'local'];

/** Tier icons (Material Symbols names). */
const TIER_ICONS = {
  core: 'public',
  inference: 'psychology',
  voice: 'mic',
  layers: 'sensors',
  local: 'home',
};

/** Keys whose input should be type=password until toggled. */
const PASSWORD_FIELDS = new Set([
  'googleMapsApiKey', 'cesiumIonToken', 'openaiApiKey',
  'aisstreamApiKey', 'firmsMapKey', 'tomtomApiKey',
  'openskyClientId', 'openskyClientSecret',
]);

/**
 * Main settings manager. Fetches from /api/settings, renders the panel,
 * and persists changes back.
 */
export class SettingsManager {
  constructor() {
    /** @type {Object} Raw settings from the API, keyed by setting name. */
    this.settings = {};
    /** @type {Object} Tier metadata from the API. */
    this.tiers = {};
    /** @type {boolean} Whether the panel is currently open. */
    this.isOpen = false;
    /** @type {HTMLDivElement|null} */
    this.panelEl = null;
    /** @type {HTMLDivElement|null} The content body inside the panel. */
    this.bodyEl = null;
    /** @type {HTMLButtonElement|null} The toggle button. */
    this.toggleBtn = null;
    /** @type {Set<string>} Which password fields are currently visible (unmasked). */
    this._revealed = new Set();
    /** @type {Set<string>} Currently hidden tiers. */
    this._collapsedTiers = new Set();
  }

  /**
   * Initialize: fetch settings, inject HTML, bind events.
   * Call once from main.js after DOM is ready.
   */
  async init() {
    this._injectHTML();
    this._bindEvents();
    await this.refresh();
  }

  /**
   * Fetch latest settings from the server and re-render.
   */
  async refresh() {
    try {
      const res = await fetch(SETTINGS_API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.settings = data.settings || {};
      this.tiers = data.tiers || {};
      this._render();
    } catch (err) {
      console.warn('[Settings] Failed to fetch settings:', err.message);
      this._renderError(err.message);
    }
  }

  /**
   * Save one or more settings to the server.
   * @param {Record<string, string>} values - Setting key/value pairs to update.
   */
  async save(values) {
    try {
      const res = await fetch(SETTINGS_API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      this.settings = data.settings || {};
      this._render();
      this._showToast('Settings saved');
      window.dispatchEvent(new CustomEvent('gev:settings-changed', { detail: { settings: this.settings } }));
    } catch (err) {
      console.error('[Settings] Save failed:', err.message);
      this._showToast(`Save failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM injection
  // ---------------------------------------------------------------------------

  _injectHTML() {
    // Add gear button to top-center-actions
    const nav = document.getElementById('top-center-actions');
    if (nav) {
      const btn = document.createElement('button');
      btn.id = 'settings-btn';
      btn.type = 'button';
      btn.title = 'API Settings';
      btn.setAttribute('aria-label', 'Open API settings');
      btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">settings</span>';
      nav.appendChild(btn);
      this.toggleBtn = btn;
    }

    // Create the settings panel in the left-panel-stack
    const stack = document.getElementById('left-panel-stack');
    if (!stack) return;

    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.className = 'panel-collapsible collapsed';
    panel.setAttribute('data-panel-id', 'settings-panel');
    panel.innerHTML = `
      <div class="panel-glow"></div>
      <div class="settings-panel-inner">
        <div class="panel-header">
          <span class="panel-title">SETTINGS</span>
          <span class="panel-divider"></span>
          <button class="panel-collapse-btn" data-collapse-target="settings-panel" title="Collapse panel">+</button>
        </div>
        <div class="settings-body">
          <div class="settings-loading">Loading settings...</div>
        </div>
      </div>
    `;
    // Insert after the nav-controls-panel (last in left stack) or at end
    const navControls = document.getElementById('nav-controls-panel');
    if (navControls) {
      navControls.after(panel);
    } else {
      stack.appendChild(panel);
    }
    this.panelEl = panel;
    this.bodyEl = panel.querySelector('.settings-body');
  }

  // ---------------------------------------------------------------------------
  // Event binding
  // ---------------------------------------------------------------------------

  _bindEvents() {
    // Gear button toggles the panel
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => {
        this._togglePanel();
      });
    }

    // Listen for collapse button clicks (standard panel pattern)
    if (this.panelEl) {
      this.panelEl.addEventListener('click', (e) => {
        const collapseBtn = e.target.closest('.panel-collapse-btn');
        if (collapseBtn) {
          this._togglePanel();
        }

        // Tier header collapse toggle
        const tierHeader = e.target.closest('.settings-tier-header');
        if (tierHeader) {
          const tier = tierHeader.dataset.tier;
          if (this._collapsedTiers.has(tier)) {
            this._collapsedTiers.delete(tier);
          } else {
            this._collapsedTiers.add(tier);
          }
          this._render();
        }

        // Password reveal toggle
        const revealBtn = e.target.closest('.settings-reveal-btn');
        if (revealBtn) {
          const key = revealBtn.dataset.key;
          if (this._revealed.has(key)) {
            this._revealed.delete(key);
          } else {
            this._revealed.add(key);
          }
          this._render();
        }

        // Test connection button
        const testBtn = e.target.closest('.settings-test-btn');
        if (testBtn) {
          this._testConnection(testBtn.dataset.key);
        }
      });
    }

    // Delegate input changes
    if (this.bodyEl) {
      this.bodyEl.addEventListener('change', (e) => {
        const input = e.target.closest('.settings-input');
        if (!input) return;
        const key = input.dataset.key;
        const value = input.value.trim();
        if (key) {
          this.save({ [key]: value });
        }
      });

      // Enter key on inputs triggers save
      this.bodyEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('settings-input')) {
          e.target.blur(); // triggers change event
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _render() {
    if (!this.bodyEl) return;
    const settings = this.settings;
    if (!settings || Object.keys(settings).length === 0) {
      this.bodyEl.innerHTML = '<div class="settings-empty">No settings available. Is the dev server running?</div>';
      return;
    }

    // Group by tier
    const grouped = {};
    for (const [key, entry] of Object.entries(settings)) {
      const tier = entry.tier || 'other';
      if (!grouped[tier]) grouped[tier] = [];
      grouped[tier].push({ key, ...entry });
    }

    let html = '';
    for (const tier of TIER_ORDER) {
      const items = grouped[tier];
      if (!items || items.length === 0) continue;
      const tierMeta = this.tiers[tier] || { label: tier.toUpperCase(), icon: 'settings', description: '' };
      const collapsed = this._collapsedTiers.has(tier);
      const activeCount = items.filter(i => i.hasValue).length;

      html += `
        <div class="settings-tier" data-tier="${tier}">
          <div class="settings-tier-header" data-tier="${tier}" role="button" tabindex="0" aria-expanded="${!collapsed}">
            <span class="material-symbols-outlined settings-tier-icon" aria-hidden="true">${TIER_ICONS[tier] || 'settings'}</span>
            <span class="settings-tier-label">${tierMeta.label}</span>
            <span class="settings-tier-count">${activeCount}/${items.length}</span>
            <span class="material-symbols-outlined settings-tier-chevron" aria-hidden="true">${collapsed ? 'expand_more' : 'expand_less'}</span>
          </div>
          ${collapsed ? '' : `<div class="settings-tier-body">${items.map(i => this._renderField(i)).join('')}</div>`}
        </div>
      `;
    }

    this.bodyEl.innerHTML = html;
  }

  /**
   * Render a single setting field.
   * @param {Object} field - { key, value, hasValue, label, required, cost, help, default }
   */
  _renderField(field) {
    const isPassword = PASSWORD_FIELDS.has(field.key);
    const revealed = this._revealed.has(field.key);
    const inputType = isPassword && !revealed ? 'password' : 'text';
    const displayValue = field.hasValue ? field.value : '';
    const placeholder = field.default || `Enter ${field.label.toLowerCase()}...`;
    const statusClass = field.hasValue ? 'configured' : (field.required ? 'required' : 'optional');
    const statusDot = field.hasValue ? '●' : (field.required ? '◆' : '○');

    return `
      <div class="settings-field ${statusClass}">
        <div class="settings-field-header">
          <span class="settings-field-status ${statusClass}" title="${statusClass}">${statusDot}</span>
          <label class="settings-field-label" for="settings-${field.key}">${field.label}</label>
          <span class="settings-field-cost">${field.cost}</span>
        </div>
        <div class="settings-field-input-row">
          <input
            id="settings-${field.key}"
            class="settings-input"
            type="${inputType}"
            data-key="${field.key}"
            value="${this._escapeAttr(displayValue)}"
            placeholder="${this._escapeAttr(placeholder)}"
            autocomplete="off"
            spellcheck="false"
          />
          ${isPassword ? `<button class="settings-reveal-btn" data-key="${field.key}" type="button" title="Toggle visibility" aria-label="Toggle visibility">
            <span class="material-symbols-outlined" aria-hidden="true">${revealed ? 'visibility_off' : 'visibility'}</span>
          </button>` : ''}
        </div>
        <div class="settings-field-help">${field.help}</div>
      </div>
    `;
  }

  _renderError(message) {
    if (!this.bodyEl) return;
    this.bodyEl.innerHTML = `
      <div class="settings-error">
        <span class="material-symbols-outlined" aria-hidden="true">error</span>
        <p>Failed to load settings</p>
        <p class="settings-error-detail">${this._escapeHtml(message)}</p>
        <button class="settings-retry-btn" type="button">Retry</button>
      </div>
    `;
    const retryBtn = this.bodyEl.querySelector('.settings-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => this.refresh());
  }

  // ---------------------------------------------------------------------------
  // Panel toggle
  // ---------------------------------------------------------------------------

  _togglePanel() {
    if (!this.panelEl) return;
    const collapsed = this.panelEl.classList.toggle('collapsed');
    this.isOpen = !collapsed;
    // Persist collapsed state using the app's existing localStorage pattern
    localStorage.setItem('godsEyeView.v1.panelCollapsed.settings-panel', collapsed ? '1' : '0');
    // Store as active for stacking
    if (!collapsed) {
      this.panelEl.classList.add('active');
    }
  }

  // ---------------------------------------------------------------------------
  // Connection testing
  // ---------------------------------------------------------------------------

  async _testConnection(key) {
    const btn = this.panelEl?.querySelector(`.settings-test-btn[data-key="${key}"]`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '...';
    }

    // Simple heuristic: check if the key is non-empty
    const setting = this.settings[key];
    if (!setting || !setting.hasValue) {
      this._showToast(`${setting?.label || key}: No value configured`);
      if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
      return;
    }

    // For now, just validate the format — full endpoint testing would require
    // server-side ping routes which can be added incrementally
    this._showToast(`${setting.label}: Value configured (${setting.value.substring(0, 8)}...)`);
    if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  _showToast(message) {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('visible');
      setTimeout(() => toast.classList.remove('visible'), 2500);
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  _escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
