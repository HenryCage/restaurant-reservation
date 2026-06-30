// logger.js — tiny structured console logger with tenant tagging and PII redaction.
//
// Logs are the operator's primary signal (spec §3, §7), so every line carries a
// timestamp, a level, and (when scoped to a tenant) a [tenant:<id>] tag. Helpers
// are provided to redact phone numbers; callers must never pass secrets/api keys.

/** @typedef {'error'|'warn'|'info'|'debug'} Level */

const LEVELS = /** @type {const} */ ({ error: 0, warn: 1, info: 2, debug: 3 });

/**
 * Mask a phone number for logs, keeping enough to correlate but not identify.
 * e.g. "+2348012345678" -> "+23480****678".
 * @param {unknown} value
 * @returns {string}
 */
export function maskPhone(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return '';
  if (s.length <= 6) return '***';
  return s.slice(0, 6) + '****' + s.slice(-3);
}

/**
 * @param {unknown} meta
 * @returns {string}
 */
function formatMeta(meta) {
  if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' ' + String(meta);
  }
}

/**
 * @typedef {Object} LoggerOptions
 * @property {Level} [level] - minimum level to emit (default 'info').
 * @property {string|null} [tenant] - tenant id tag.
 * @property {() => Date} [now] - clock (injectable for tests).
 * @property {Pick<Console,'log'|'error'>} [sink] - output sink (injectable for tests).
 */

/**
 * @typedef {Object} Logger
 * @property {(msg: string, meta?: object) => void} error
 * @property {(msg: string, meta?: object) => void} warn
 * @property {(msg: string, meta?: object) => void} info
 * @property {(msg: string, meta?: object) => void} debug
 * @property {(tenantId: string) => Logger} child
 */

/**
 * Create a logger.
 * @param {LoggerOptions} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const { level = 'info', tenant = null, now = () => new Date(), sink = console } = options;
  const threshold = LEVELS[level] ?? LEVELS.info;

  /**
   * @param {Level} lvl
   * @param {string} msg
   * @param {object} [meta]
   */
  function emit(lvl, msg, meta) {
    if (LEVELS[lvl] > threshold) return;
    const ts = now().toISOString();
    const tag = tenant ? ` [tenant:${tenant}]` : '';
    const line = `${ts} ${lvl.toUpperCase()}${tag} ${msg}${formatMeta(meta)}`;
    if (lvl === 'error' || lvl === 'warn') sink.error(line);
    else sink.log(line);
  }

  return {
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
    child: (tenantId) => createLogger({ level, tenant: tenantId, now, sink }),
  };
}
