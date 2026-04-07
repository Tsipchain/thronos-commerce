'use strict';

const DEFAULT_ASSISTANT_CONFIG = {
  enabled: false,
  apiKey: '',
  webhookUrl: '',
  notifyNewOrders: true,
  notifyLowStock: true,
  notifyTrackingReminder: true,
  lowStockThreshold: 3,
  vaEnabled: false,
  vaMode: 'disabled',         /* disabled | customer | merchant | both */
  vaLanguage: 'auto',         /* auto | el | en */
  vaTone: 'friendly',         /* friendly | professional | technical */
  vaBrandVoice: '',
  vaStoreInstructions: '',
  vaProductGuidance: '',
  vaCustomerSupport: '',
  vaAvoidTopics: '',
  vaMerchantGoals: ''
};

const _VALID_MODES = ['disabled', 'customer', 'merchant', 'both'];
const _VALID_LANGS = ['auto', 'el', 'en'];
const _VALID_TONES = ['friendly', 'professional', 'technical'];
const _FREE_TEXT_FIELDS = [
  'apiKey', 'webhookUrl', 'vaBrandVoice',
  'vaStoreInstructions', 'vaProductGuidance',
  'vaCustomerSupport', 'vaAvoidTopics', 'vaMerchantGoals'
];

/**
 * Merge raw (potentially partial) assistant config over defaults and
 * enforce valid enum values. Returns a clean, fully-populated object.
 *
 * @param {object} raw  - Tenant's raw assistant config (may be empty/partial)
 * @returns {object}    - Normalised config with all fields present
 */
function normalizeAssistantConfig(raw) {
  const out = Object.assign({}, DEFAULT_ASSISTANT_CONFIG, raw && typeof raw === 'object' ? raw : {});

  // Booleans
  out.enabled = !!out.enabled;
  out.vaEnabled = !!out.vaEnabled;
  out.notifyNewOrders = out.notifyNewOrders !== false;
  out.notifyLowStock = out.notifyLowStock !== false;
  out.notifyTrackingReminder = out.notifyTrackingReminder !== false;
  out.lowStockThreshold = Math.max(1, parseInt(out.lowStockThreshold, 10) || 3);

  // Enums
  if (!_VALID_MODES.includes(out.vaMode)) out.vaMode = 'disabled';
  if (!_VALID_LANGS.includes(out.vaLanguage)) out.vaLanguage = 'auto';
  if (!_VALID_TONES.includes(out.vaTone)) out.vaTone = 'friendly';

  // Free-text strings (capped at 2000 chars each)
  _FREE_TEXT_FIELDS.forEach((k) => {
    out[k] = typeof out[k] === 'string' ? out[k].slice(0, 2000) : '';
  });

  return out;
}

module.exports = { DEFAULT_ASSISTANT_CONFIG, normalizeAssistantConfig };
