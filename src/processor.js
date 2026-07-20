// processor.js — the core poll-tick loop (spec §7).
//
// Responsibilities:
//   - single-flight: never run two ticks at once;
//   - per-tenant isolation: one tenant's failure never stops the others;
//   - decide -> send -> per-row write-back (immediately after each send) so a
//     crash/timeout can re-send at most one message, not a whole tenant's batch;
//   - bulk-edit guardrail and transient/permanent failure handling (no Attempts
//     column: a permanent failure marks the status, which un-parks on a Status change);
//   - operator-visible logging plus a one-line per-tenant summary each tick;
//   - optional onRow(tenant, contact) hook fires once per scanned row with a
//     valid phone, every tick, regardless of notify-status eligibility or
//     send outcome (sheet -> contacts sync; see index.js).
//
// All I/O (registry, sheets, sendSms) is injected, so the whole loop is unit-tested
// with mocks and never touches the network or googleapis.

import { canonicalStatus } from './tenants.js';
import { buildMessage } from './message.js';
import { normalisePhone } from './phone.js';
import { maskPhone } from './logger.js';

/**
 * @param {{
 *   config: import('./config.js').Config,
 *   logger: import('./logger.js').Logger,
 *   registry: { load: () => import('./tenants.js').Tenant[] },
 *   sheets: {
 *     readOrders: (sheetId: string, sheetName: string) => Promise<any>,
 *     writeRow: (sheetId: string, sheetName: string, rowNumber: number, colIndex: Record<string,number>, fields: object) => Promise<void>,
 *   },
 *   smsSenderFactory: { forTenant: (tenant: import('./tenants.js').Tenant) => (to: string, message: string, opts: { senderId: string, channel?: string }) => Promise<{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }> },
 *   onRow?: (tenant: import('./tenants.js').Tenant, contact: { name: string, phone: string }) => void,
 *   now?: () => Date,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export function createProcessor(deps) {
  const { config, logger, registry, sheets, smsSenderFactory, onRow } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));

  let running = false;

  /**
   * A tenant's own default country code (if it has one set) always wins over
   * the global DEFAULT_COUNTRY_CODE -- lets a bare (no "+") phone number in
   * this tenant's sheet resolve against its actual customer base instead of
   * always assuming Nigeria (Per-tenant SMS provider spec's sibling fix).
   * @param {import('./tenants.js').Tenant} tenant
   * @returns {string}
   */
  function countryCodeFor(tenant) {
    return tenant.defaultCountryCode || config.defaultCountryCode;
  }

  /**
   * Resolve the actual recipient: a test override (already gated by config) wins,
   * otherwise the validated customer number. Override numbers are normalised when
   * possible, falling back to the raw string.
   * @param {import('./tenants.js').Tenant} tenant
   * @param {string} customerE164
   * @returns {string}
   */
  function resolveRecipient(tenant, customerE164) {
    const override = config.effectiveGlobalTestNumber || tenant.testNumber || '';
    if (override) return normalisePhone(override, countryCodeFor(tenant)) || override;
    return customerE164;
  }

  /**
   * Process a single tenant. Returns a summary; never throws for expected errors.
   * @param {import('./tenants.js').Tenant} tenant
   */
  async function processTenant(tenant) {
    const log = logger.child(tenant.id);
    const summary = {
      tenantId: tenant.id,
      scanned: 0,
      eligible: 0,
      sentOk: 0,
      transientFail: 0,
      permanentFail: 0,
      invalidPhone: 0,
      writeErrors: 0,
      capped: false,
    };

    if (tenant.smsProvider === '') {
      log.warn('tenant has no SMS provider configured; skipping this tick');
      return summary;
    }
    const sendSms = smsSenderFactory.forTenant(tenant);

    const read = await sheets.readOrders(tenant.sheetId, tenant.sheetName);
    if (!read.ok) {
      log.error(`sheet read/parse failed: ${read.error}`);
      return summary;
    }

    const { colIndex, rows } = read;
    summary.scanned = rows.length;

    // Sheet -> contacts sync: every scanned row's customer is mirrored into
    // contacts, independent of notify-status eligibility or send outcome --
    // a customer should exist in contacts as soon as their order appears in
    // the sheet, not only once/if they get notified. Isolated per row so a
    // hook failure can never affect sheet processing itself.
    if (onRow) {
      for (const row of rows) {
        const e164 = normalisePhone(row.phone, countryCodeFor(tenant));
        if (!e164) continue;
        try {
          onRow(tenant, { name: row.name, phone: e164 });
        } catch (err) {
          log.error('onRow hook failed (isolated)', { orderId: row.orderId, error: err?.message ?? String(err) });
        }
      }
    }

    // Decide which rows need a message.
    const eligible = [];
    for (const row of rows) {
      const canonStatus = canonicalStatus(row.status);
      if (!tenant.notifyStatusesCanonical.has(canonStatus)) continue;
      if (canonStatus === canonicalStatus(row.lastNotifiedStatus)) continue; // already handled / given up

      const e164 = normalisePhone(row.phone, countryCodeFor(tenant));
      if (!e164) {
        summary.invalidPhone += 1;
        log.warn('invalid phone, skipping row', { orderId: row.orderId, phone: maskPhone(row.phone) });
        continue;
      }
      eligible.push({ row, canonStatus, e164 });
    }
    summary.eligible = eligible.length;

    // Bulk-edit guardrail: cap sends per tenant per tick, defer the rest.
    let toProcess = eligible;
    if (eligible.length > config.maxSendsPerTenantPerTick) {
      summary.capped = true;
      log.warn(
        `bulk-edit guard: ${eligible.length} eligible rows exceed cap ${config.maxSendsPerTenantPerTick}; ` +
          `processing first ${config.maxSendsPerTenantPerTick} this tick, deferring the rest`,
      );
      toProcess = eligible.slice(0, config.maxSendsPerTenantPerTick);
    }

    for (const { row, canonStatus, e164 } of toProcess) {
      try {
        await processRow(tenant, log, colIndex, row, canonStatus, e164, summary, sendSms);
      } catch (err) {
        // Defensive: an unexpected throw on one row must not stop later rows.
        log.error('unexpected error processing row (isolated)', {
          orderId: row.orderId,
          error: err?.message ?? String(err),
        });
      }
      if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);
    }

    log.info(
      `tick summary: scanned=${summary.scanned} eligible=${summary.eligible} sent=${summary.sentOk} ` +
        `transient_fail=${summary.transientFail} permanent_fail=${summary.permanentFail} ` +
        `invalid_phone=${summary.invalidPhone} write_errors=${summary.writeErrors}` +
        (summary.capped ? ' [CAPPED]' : ''),
    );
    return summary;
  }

  /**
   * Build + send one message and write back its result row immediately.
   * @param {import('./tenants.js').Tenant} tenant
   * @param {import('./logger.js').Logger} log
   * @param {Record<string, number>} colIndex
   * @param {import('./sheets.js').OrderRow} row
   * @param {string} canonStatus
   * @param {string} e164
   * @param {any} summary
   * @param {(to: string, message: string, opts: any) => Promise<any>} sendSms
   */
  async function processRow(tenant, log, colIndex, row, canonStatus, e164, summary, sendSms) {
    const template = tenant.templatesByCanonical[canonStatus];
    const message = buildMessage(template, { name: row.name, orderId: row.orderId, amount: row.amount });
    const recipient = resolveRecipient(tenant, e164);

    /** @type {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} */
    let result;
    if (config.dryRun) {
      log.info('DRY_RUN: would send', {
        orderId: row.orderId,
        to: maskPhone(recipient),
        status: row.status,
      });
      result = { ok: true, providerMessageId: 'dry-run' };
    } else {
      result = await sendSms(recipient, message, { senderId: tenant.senderId, channel: tenant.channel });
    }

    if (result.ok) {
      await safeWrite(log, summary, tenant, row.rowNumber, colIndex, {
        lastNotifiedStatus: canonStatus,
        notifiedAt: now().toISOString(),
        lastError: '',
      });
      summary.sentOk += 1;
      log.info('sent', {
        orderId: row.orderId,
        to: maskPhone(recipient),
        status: row.status,
        providerMessageId: result.providerMessageId,
      });
      return;
    }

    if (result.permanent) {
      // Give up on this status so it does not retry forever / burn paid rejects.
      // Setting Last Notified Status makes the row inert until Status changes.
      await safeWrite(log, summary, tenant, row.rowNumber, colIndex, {
        lastNotifiedStatus: canonStatus,
        lastError: result.error ?? 'permanent failure',
      });
      summary.permanentFail += 1;
      log.error('permanent send failure (giving up on this status)', {
        orderId: row.orderId,
        to: maskPhone(recipient),
        error: result.error,
      });
      return;
    }

    // Transient: leave Last Notified Status unchanged so it retries next tick.
    await safeWrite(log, summary, tenant, row.rowNumber, colIndex, {
      lastError: result.error ?? 'transient failure',
    });
    summary.transientFail += 1;
    log.warn('transient send failure (will retry next tick)', {
      orderId: row.orderId,
      error: result.error,
    });
  }

  /**
   * Write back service cells, isolating sheet-write failures (log + continue).
   * A write failure after a successful send means at-least-once for that one row.
   */
  async function safeWrite(log, summary, tenant, rowNumber, colIndex, fields) {
    try {
      await sheets.writeRow(tenant.sheetId, tenant.sheetName, rowNumber, colIndex, fields);
    } catch (err) {
      summary.writeErrors += 1;
      log.error('write-back failed (row may be reprocessed next tick)', {
        rowNumber,
        error: err?.message ?? String(err),
      });
    }
  }

  return {
    /**
     * Run one poll tick. Single-flight: returns immediately if a tick is in flight.
     * @returns {Promise<{ skipped: boolean, tenants?: number, summaries?: any[] }>}
     */
    async run() {
      if (running) {
        logger.warn('tick skipped: previous tick still running (single-flight)');
        return { skipped: true };
      }
      running = true;
      try {
        const tenants = registry.load();
        if (tenants.length === 0) {
          logger.info('no active tenants this tick');
          return { skipped: false, tenants: 0, summaries: [] };
        }
        const summaries = [];
        for (const tenant of tenants) {
          try {
            summaries.push(await processTenant(tenant));
          } catch (err) {
            logger
              .child(tenant.id)
              .error('tenant processing crashed (isolated from other tenants)', {
                error: err?.message ?? String(err),
              });
            summaries.push({ tenantId: tenant.id, crashed: true });
          }
        }
        return { skipped: false, tenants: tenants.length, summaries };
      } finally {
        running = false;
      }
    },
  };
}
