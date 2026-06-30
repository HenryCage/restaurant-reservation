// config.js — parse and validate shared environment configuration (spec §6).
//
// Validation is fail-fast and provider-conditional: all problems are collected
// and reported at once, so the operator fixes everything in one pass instead of
// rediscovering errors one restart at a time. loadConfig() is pure (it reads
// from a passed-in env object) so it is unit-testable without touching process.env.

const VALID_PROVIDERS = new Set(['termii', 'africastalking']);

/**
 * @param {string|undefined} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(true|1|yes|on)$/i.test(value.trim());
}

/**
 * Parse a positive integer env var with a default and bounds check.
 * @param {Record<string,string|undefined>} env
 * @param {string} name
 * @param {number} fallback
 * @param {string[]} errors
 * @param {number} [min]
 * @returns {number}
 */
function parseIntEnv(env, name, fallback, errors, min = 1) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`${name} must be an integer >= ${min} (got "${raw}")`);
    return fallback;
  }
  return n;
}

/**
 * @param {Record<string,string|undefined>} env
 * @param {string} name
 * @param {string[]} errors
 * @returns {string}
 */
function requireStr(env, name, errors) {
  const v = (env[name] ?? '').trim();
  if (v === '') errors.push(`${name} is required`);
  return v;
}

/**
 * @typedef {ReturnType<typeof loadConfig>} Config
 */

/**
 * Load and validate config. Throws an Error listing all problems if invalid.
 * @param {Record<string, string|undefined>} [env]
 * @returns {object}
 */
export function loadConfig(env = process.env) {
  /** @type {string[]} */
  const errors = [];

  const nodeEnv = (env.NODE_ENV ?? 'production').trim() || 'production';

  // Google (always required)
  const serviceAccountEmail = requireStr(env, 'GOOGLE_SERVICE_ACCOUNT_EMAIL', errors);
  let privateKey = (env.GOOGLE_PRIVATE_KEY ?? '').trim();
  if (privateKey === '') {
    errors.push('GOOGLE_PRIVATE_KEY is required');
  } else {
    // .env stores the key with literal \n sequences; turn them into real newlines.
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  // SMS provider selection (provider-conditional requirements)
  const smsProvider = (env.SMS_PROVIDER ?? 'termii').trim().toLowerCase();
  if (!VALID_PROVIDERS.has(smsProvider)) {
    errors.push(`SMS_PROVIDER must be one of: ${[...VALID_PROVIDERS].join(', ')} (got "${env.SMS_PROVIDER}")`);
  }

  const termii = { apiKey: (env.TERMII_API_KEY ?? '').trim(), baseUrl: (env.TERMII_BASE_URL ?? '').trim() };
  const africasTalking = {
    apiKey: (env.AT_API_KEY ?? '').trim(),
    username: (env.AT_USERNAME ?? '').trim(),
  };

  if (smsProvider === 'termii') {
    if (termii.apiKey === '') errors.push('TERMII_API_KEY is required when SMS_PROVIDER=termii');
    if (termii.baseUrl === '') errors.push('TERMII_BASE_URL is required when SMS_PROVIDER=termii');
  } else if (smsProvider === 'africastalking') {
    if (africasTalking.apiKey === '') errors.push('AT_API_KEY is required when SMS_PROVIDER=africastalking');
    if (africasTalking.username === '') errors.push('AT_USERNAME is required when SMS_PROVIDER=africastalking');
  }

  const defaultCountryCode = (env.DEFAULT_COUNTRY_CODE ?? '234').replace(/\D/g, '') || '234';

  const pollIntervalSeconds = parseIntEnv(env, 'POLL_INTERVAL_SECONDS', 60, errors);
  const sendDelayMs = parseIntEnv(env, 'SEND_DELAY_MS', 400, errors, 0);
  const httpTimeoutMs = parseIntEnv(env, 'HTTP_TIMEOUT_MS', 15000, errors);
  const maxSendsPerTenantPerTick = parseIntEnv(env, 'MAX_SENDS_PER_TENANT_PER_TICK', 50, errors);

  const tenantsFile = (env.TENANTS_FILE ?? './tenants.json').trim() || './tenants.json';
  const dryRun = parseBool(env.DRY_RUN, false);

  const globalTestNumber = (env.GLOBAL_TEST_NUMBER ?? '').trim();
  const isProduction = nodeEnv === 'production';
  const testOverrideActive = globalTestNumber !== '' && !isProduction;
  const globalTestNumberIgnored = globalTestNumber !== '' && isProduction;

  if (errors.length > 0) {
    throw new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
  }

  return Object.freeze({
    nodeEnv,
    isProduction,
    google: Object.freeze({ serviceAccountEmail, privateKey }),
    smsProvider,
    termii: Object.freeze(termii),
    africasTalking: Object.freeze(africasTalking),
    defaultCountryCode,
    pollIntervalSeconds,
    sendDelayMs,
    httpTimeoutMs,
    maxSendsPerTenantPerTick,
    tenantsFile,
    dryRun,
    globalTestNumber,
    /** recipient override actually in effect (empty unless honored) */
    effectiveGlobalTestNumber: testOverrideActive ? globalTestNumber : '',
    testOverrideActive,
    globalTestNumberIgnored,
  });
}

/**
 * One-line, secret-free description of the effective run mode (startup banner).
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {string}
 */
export function describeConfig(config) {
  const sandbox = config.smsProvider === 'africastalking' && config.africasTalking.username === 'sandbox';
  const parts = [
    `mode=${config.nodeEnv}`,
    `provider=${config.smsProvider}`,
    `sandbox=${sandbox}`,
    `dry_run=${config.dryRun}`,
    `test_override=${config.testOverrideActive ? 'ON' : 'off'}`,
    `poll=${config.pollIntervalSeconds}s`,
    `max_sends/tenant/tick=${config.maxSendsPerTenantPerTick}`,
  ];
  return parts.join(' ');
}
