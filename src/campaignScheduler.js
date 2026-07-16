// campaignScheduler.js — campaign tick loop, sibling to processor.js (Foundation merge spec).
//
// Same discipline as processor.js: single-flight, per-tenant isolation,
// send-then-write-back-immediately (one recipient at a time), a bulk-edit
// guardrail, and transient/permanent failure handling. Fully separate tick
// and dependency set from the sheet engine — zero coupling to processor.js.

import { normalisePhone } from './phone.js';
import { maskPhone } from './logger.js';

/**
 * @param {{
 *   config: import('./config.js').Config,
 *   logger: import('./logger.js').Logger,
 *   registry: { load: () => import('./tenants.js').Tenant[] },
 *   campaignsStore: ReturnType<typeof import('./campaigns.js').createCampaignsStore>,
 *   smsSenderFactory: { forTenant: (tenant: import('./tenants.js').Tenant) => (to: string, message: string, opts: { senderId: string, channel?: string }) => Promise<{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }> },
 *   now?: () => Date,
 * }} deps
 */
export function createCampaignScheduler(deps) {
  const { config, logger, registry, campaignsStore, smsSenderFactory } = deps;
  const now = deps.now ?? (() => new Date());

  let running = false;

  /**
   * Resolve the actual recipient: a test override (already gated by config)
   * wins, otherwise the contact's own number. Mirrors processor.js's
   * resolveRecipient exactly (duplicated rather than imported, to keep
   * processor.js's dependency surface untouched — see the spec).
   * @param {import('./tenants.js').Tenant} tenant
   * @param {string} contactE164
   * @returns {string}
   */
  function resolveRecipient(tenant, contactE164) {
    const override = config.effectiveGlobalTestNumber || tenant.testNumber || '';
    if (override) return normalisePhone(override, config.defaultCountryCode) || override;
    return contactE164;
  }

  /**
   * Send to one recipient and write the outcome back immediately.
   * @param {import('./tenants.js').Tenant} tenant
   * @param {import('./logger.js').Logger} log
   * @param {any} campaign
   * @param {any} recipient
   * @param {(to: string, message: string, opts: any) => Promise<any>} sendSms
   */
  async function sendToRecipient(tenant, log, campaign, recipient, sendSms) {
    const contactE164 = normalisePhone(recipient.phone, config.defaultCountryCode) || recipient.phone;
    const to = resolveRecipient(tenant, contactE164);

    /** @type {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} */
    let result;
    if (config.dryRun) {
      log.info('DRY_RUN: would send campaign message', { campaignId: campaign.id, to: maskPhone(to) });
      result = { ok: true, providerMessageId: 'dry-run' };
    } else {
      result = await sendSms(to, campaign.message, { senderId: tenant.senderId, channel: tenant.channel });
    }

    if (result.ok) {
      campaignsStore.recordRecipientResult(recipient.id, {
        status: 'sent',
        providerMessageId: result.providerMessageId ?? null,
      });
      log.info('campaign message sent', { campaignId: campaign.id, to: maskPhone(to) });
      return;
    }

    if (result.permanent) {
      campaignsStore.recordRecipientResult(recipient.id, { status: 'failed', error: result.error ?? 'permanent failure' });
      log.error('permanent campaign send failure (giving up on this recipient)', {
        campaignId: campaign.id,
        to: maskPhone(to),
        error: result.error,
      });
      return;
    }

    // Transient: leave the recipient 'pending' so it retries next tick.
    log.warn('transient campaign send failure (will retry next tick)', {
      campaignId: campaign.id,
      to: maskPhone(to),
      error: result.error,
    });
  }

  /**
   * Process one tenant's due campaigns.
   * @param {import('./tenants.js').Tenant} tenant
   * @param {any[]} campaigns
   */
  async function processTenantCampaigns(tenant, campaigns) {
    const log = logger.child(tenant.id);

    if (tenant.smsProvider === '') {
      log.warn('tenant has no SMS provider configured; skipping this tick\'s campaigns');
      return;
    }
    const sendSms = smsSenderFactory.forTenant(tenant);

    for (const campaign of campaigns) {
      try {
        campaignsStore.ensureRecipients(campaign.id, tenant.id, campaign.sendTo);

        // Fetch one past the cap so we can tell "exactly at the cap" apart from
        // "more than the cap" without a separate COUNT query (mirrors
        // processor.js's eligible.length > cap check, just via LIMIT+1).
        const fetched = campaignsStore.pendingRecipients(campaign.id, config.maxCampaignRecipientsPerTick + 1);
        const capped = fetched.length > config.maxCampaignRecipientsPerTick;
        const pending = capped ? fetched.slice(0, config.maxCampaignRecipientsPerTick) : fetched;
        if (capped) {
          log.warn(
            `bulk-guard: campaign "${campaign.name}" has more than ${config.maxCampaignRecipientsPerTick} ` +
              'pending recipients; processing this tick\'s cap, deferring the rest',
            { campaignId: campaign.id },
          );
        }

        for (const recipient of pending) {
          try {
            await sendToRecipient(tenant, log, campaign, recipient, sendSms);
          } catch (err) {
            // Defensive: an unexpected throw on one recipient must not stop the others.
            log.error('unexpected error sending to recipient (isolated)', {
              campaignId: campaign.id,
              recipientId: recipient.id,
              error: err?.message ?? String(err),
            });
          }
        }

        campaignsStore.recomputeCampaignStatus(campaign.id);
      } catch (err) {
        log.error('unexpected error processing campaign (isolated)', {
          campaignId: campaign.id,
          error: err?.message ?? String(err),
        });
      }
    }
  }

  return {
    /**
     * Run one campaign tick. Single-flight: returns immediately if a tick is in flight.
     * @returns {Promise<{ skipped: boolean, tenants?: number }>}
     */
    async run() {
      if (running) {
        logger.warn('campaign tick skipped: previous tick still running (single-flight)');
        return { skipped: true };
      }
      running = true;
      try {
        const due = campaignsStore.listDueCampaigns(now());
        if (due.length === 0) {
          return { skipped: false, tenants: 0 };
        }

        const tenantsById = new Map(registry.load().map((t) => [t.id, t]));
        const byTenant = new Map();
        for (const campaign of due) {
          if (!byTenant.has(campaign.tenantId)) byTenant.set(campaign.tenantId, []);
          byTenant.get(campaign.tenantId).push(campaign);
        }

        for (const [tenantId, campaigns] of byTenant) {
          const tenant = tenantsById.get(tenantId);
          if (!tenant) {
            logger.warn(`campaign tick: tenant "${tenantId}" is not active; deferring its due campaigns`, {
              tenantId,
              campaignCount: campaigns.length,
            });
            continue;
          }
          try {
            await processTenantCampaigns(tenant, campaigns);
          } catch (err) {
            logger.child(tenantId).error('tenant campaign processing crashed (isolated from other tenants)', {
              error: err?.message ?? String(err),
            });
          }
        }

        return { skipped: false, tenants: byTenant.size };
      } finally {
        running = false;
      }
    },
  };
}
