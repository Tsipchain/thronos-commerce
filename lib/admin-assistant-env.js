'use strict';

/**
 * Canonical environment variable resolution for the VCA backend connection.
 *
 * Priority order:
 *   VCA base URL : THRONOS_ASSISTANT_URL → ASSISTANT_API_URL → VCA_URL
 *   Shared secret: COMMERCE_WEBHOOK_SECRET → ASSISTANT_WEBHOOK_SECRET
 *
 * logAssistantBoot() prints source names only — never secret values.
 */

const ENV_VCA_URL_CHAIN = [
  'THRONOS_ASSISTANT_URL',
  'ASSISTANT_API_URL',
  'VCA_URL',
];

const ENV_SECRET_CHAIN = [
  'COMMERCE_WEBHOOK_SECRET',
  'ASSISTANT_WEBHOOK_SECRET',
];

function resolveVcaUrl() {
  for (const key of ENV_VCA_URL_CHAIN) {
    const val = (process.env[key] || '').trim().replace(/\/$/, '');
    if (val) return { url: val, source: key };
  }
  return { url: '', source: 'none' };
}

function resolveWebhookSecret() {
  for (const key of ENV_SECRET_CHAIN) {
    const val = (process.env[key] || '').trim();
    if (val) return { secret: val, source: key };
  }
  return { secret: '', source: 'none' };
}

function logAssistantBoot(label) {
  const { url, source: urlSource } = resolveVcaUrl();
  const { source: secretSource } = resolveWebhookSecret();
  const urlStatus = url ? 'configured' : 'NOT_CONFIGURED';
  // eslint-disable-next-line no-console
  console.log(
    `[${label || 'assistant-env'}] boot` +
    ` assistantUrlSource=${urlSource}(${urlStatus})` +
    ` webhookSecretSource=${secretSource}`
  );
}

module.exports = {
  resolveVcaUrl,
  resolveWebhookSecret,
  logAssistantBoot,
  ENV_VCA_URL_CHAIN,
  ENV_SECRET_CHAIN,
};
