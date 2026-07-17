// campaigns.js — per-tenant manual/scheduled campaigns store (Foundation merge spec).
//
// campaign_recipients is a separate table (not an aggregate success/fail string)
// so each recipient's outcome is individually auditable and crash-safe: a send
// is written back immediately, one recipient at a time, mirroring sheets.js's
// cell-scoped write-back for the sheet-driven engine.

import { randomUUID } from 'node:crypto';
import { sanitiseText } from './message.js';

const MAX_MESSAGE_LEN = 1600; // ~10 SMS segments; a sane cap, not a hard provider limit.

/** @param {any} row */
function toCampaign(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    type: row.type,
    message: row.message,
    sendTo: row.send_to,
    scheduledTime: row.scheduled_time,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

/** @param {any} row */
function toRecipient(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    phone: row.phone,
    status: row.status,
    providerMessageId: row.provider_message_id,
    error: row.error,
    sentAt: row.sent_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => Date }} [deps]
 */
export function createCampaignsStore(db, deps = {}) {
  const now = deps.now ?? (() => new Date());

  const insertCampaignStmt = db.prepare(
    `INSERT INTO campaigns (id, tenant_id, name, type, message, send_to, scheduled_time, status, created_at)
     VALUES (?, ?, ?, 'sms', ?, ?, ?, 'pending', ?)`,
  );
  const findContactStmt = db.prepare('SELECT id, phone FROM contacts WHERE tenant_id = ? AND id = ?');
  const tenantContactsStmt = db.prepare('SELECT id, phone FROM contacts WHERE tenant_id = ?');
  const listCampaignsStmt = db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY created_at DESC');
  const getCampaignStmt = db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?');
  const updateCampaignStmt = db.prepare(
    'UPDATE campaigns SET name = ?, message = ?, send_to = ?, scheduled_time = ? WHERE tenant_id = ? AND id = ?',
  );
  const cancelCampaignStmt = db.prepare("UPDATE campaigns SET status = 'cancelled' WHERE tenant_id = ? AND id = ?");
  const setCampaignFailedStmt = db.prepare("UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?");
  const recipientsForCampaignStmt = db.prepare('SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY rowid');
  const dueCampaignsStmt = db.prepare(
    `SELECT * FROM campaigns WHERE status IN ('pending','processing') AND scheduled_time <= ? ORDER BY scheduled_time`,
  );
  const setProcessingStmt = db.prepare(`UPDATE campaigns SET status = 'processing' WHERE id = ? AND status = 'pending'`);
  const setCampaignStatusStmt = db.prepare('UPDATE campaigns SET status = ? WHERE id = ?');
  const existingRecipientContactIdsStmt = db.prepare('SELECT contact_id FROM campaign_recipients WHERE campaign_id = ?');
  const insertRecipientStmt = db.prepare(
    'INSERT INTO campaign_recipients (id, campaign_id, contact_id, phone, status) VALUES (?, ?, ?, ?, ?)',
  );
  const pendingRecipientsStmt = db.prepare(
    "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' LIMIT ?",
  );
  const updateRecipientStmt = db.prepare(
    'UPDATE campaign_recipients SET status = ?, provider_message_id = ?, error = ?, sent_at = ? WHERE id = ?',
  );
  const recipientStatusesStmt = db.prepare('SELECT status FROM campaign_recipients WHERE campaign_id = ?');

  return {
    /**
     * @param {string} tenantId
     * @param {{ name: string, message: string, sendTo: string, scheduledTime: string|Date }} input
     */
    createCampaign(tenantId, { name, message, sendTo, scheduledTime }) {
      if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required');

      if (sendTo !== 'all' && !findContactStmt.get(tenantId, sendTo)) {
        throw new Error(`sendTo "${sendTo}" is not a known contact for this tenant`);
      }

      const cleanMessage = sanitiseText(message, MAX_MESSAGE_LEN);
      if (cleanMessage === '') throw new Error('message must not be empty');

      const schedDate = new Date(scheduledTime);
      if (Number.isNaN(schedDate.getTime())) throw new Error(`invalid scheduledTime: ${scheduledTime}`);

      const id = randomUUID();
      const createdAt = now().toISOString();
      const scheduledIso = schedDate.toISOString();
      insertCampaignStmt.run(id, tenantId, name, cleanMessage, sendTo, scheduledIso, createdAt);
      return {
        id,
        tenantId,
        name,
        type: 'sms',
        message: cleanMessage,
        sendTo,
        scheduledTime: scheduledIso,
        status: 'pending',
        error: null,
        createdAt,
      };
    },

    /**
     * @param {Date} at
     * @returns {ReturnType<typeof toCampaign>[]}
     */
    listDueCampaigns(at) {
      return dueCampaignsStmt.all(at.toISOString()).map(toCampaign);
    },

    /**
     * All campaigns for one tenant, newest first (HTTP API read path).
     * @param {string} tenantId
     * @returns {ReturnType<typeof toCampaign>[]}
     */
    listCampaigns(tenantId) {
      return listCampaignsStmt.all(tenantId).map(toCampaign);
    },

    /**
     * Partial merge, only while the campaign is still 'pending' -- once
     * ensureRecipients has flipped it to 'processing' the scheduler may
     * already be mid-send, so editing after that point is refused rather
     * than racing it.
     * @param {string} tenantId
     * @param {string} campaignId
     * @param {{ name?: string, message?: string, sendTo?: string, scheduledTime?: string|Date }} [input]
     */
    updateCampaign(tenantId, campaignId, { name, message, sendTo, scheduledTime } = {}) {
      const existing = getCampaignStmt.get(tenantId, campaignId);
      if (!existing) throw new Error('campaign not found');
      if (existing.status !== 'pending') throw new Error('only a pending campaign can be edited');

      const nextName = name !== undefined ? name : existing.name;
      if (typeof nextName !== 'string' || nextName.trim() === '') throw new Error('name is required');

      const nextSendTo = sendTo !== undefined ? sendTo : existing.send_to;
      if (nextSendTo !== 'all' && !findContactStmt.get(tenantId, nextSendTo)) {
        throw new Error(`sendTo "${nextSendTo}" is not a known contact for this tenant`);
      }

      const nextMessage = message !== undefined ? sanitiseText(message, MAX_MESSAGE_LEN) : existing.message;
      if (nextMessage === '') throw new Error('message must not be empty');

      let nextScheduledIso = existing.scheduled_time;
      if (scheduledTime !== undefined) {
        const schedDate = new Date(scheduledTime);
        if (Number.isNaN(schedDate.getTime())) throw new Error(`invalid scheduledTime: ${scheduledTime}`);
        nextScheduledIso = schedDate.toISOString();
      }

      updateCampaignStmt.run(nextName, nextMessage, nextSendTo, nextScheduledIso, tenantId, campaignId);
      return toCampaign(getCampaignStmt.get(tenantId, campaignId));
    },

    /**
     * Only while still 'pending', same boundary as updateCampaign.
     * @param {string} tenantId
     * @param {string} campaignId
     */
    cancelCampaign(tenantId, campaignId) {
      const existing = getCampaignStmt.get(tenantId, campaignId);
      if (!existing) throw new Error('campaign not found');
      if (existing.status !== 'pending') throw new Error('only a pending campaign can be cancelled');

      cancelCampaignStmt.run(tenantId, campaignId);
      return toCampaign(getCampaignStmt.get(tenantId, campaignId));
    },

    /**
     * Per-recipient outcomes for one campaign (send status/error/timestamp).
     * @param {string} tenantId
     * @param {string} campaignId
     * @returns {ReturnType<typeof toRecipient>[]|null} null if the campaign doesn't belong to this tenant.
     */
    listRecipients(tenantId, campaignId) {
      const campaign = getCampaignStmt.get(tenantId, campaignId);
      if (!campaign) return null;
      return recipientsForCampaignStmt.all(campaignId).map(toRecipient);
    },

    /**
     * Idempotent: safe to call every tick. Resolves `sendTo` against the
     * tenant's current contacts and inserts any recipient rows not yet present.
     * @param {string} campaignId
     * @param {string} tenantId
     * @param {string} sendTo
     */
    ensureRecipients(campaignId, tenantId, sendTo) {
      setProcessingStmt.run(campaignId);

      const already = new Set(existingRecipientContactIdsStmt.all(campaignId).map((r) => r.contact_id));

      // A single-contact campaign whose target no longer exists (e.g. the
      // contact was deleted after scheduling but before this campaign became
      // due -- deleting a contact is only blocked once it already HAS
      // recipient rows, i.e. after this point). already.size === 0 scopes
      // this to that first-ever tick only: fail explicitly here rather than
      // silently leaving the campaign at 'processing' with zero recipients
      // forever (recomputeCampaignStatus never fires on an empty list, and a
      // non-pending campaign can no longer be edited or cancelled either).
      if (sendTo !== 'all' && already.size === 0 && !findContactStmt.get(tenantId, sendTo)) {
        setCampaignFailedStmt.run('target contact no longer exists', campaignId);
        return;
      }

      const targets = sendTo === 'all' ? tenantContactsStmt.all(tenantId) : [findContactStmt.get(tenantId, sendTo)].filter(Boolean);

      for (const target of targets) {
        if (already.has(target.id)) continue;
        insertRecipientStmt.run(randomUUID(), campaignId, target.id, target.phone, 'pending');
      }
    },

    /**
     * @param {string} campaignId
     * @param {number} limit
     */
    pendingRecipients(campaignId, limit) {
      return pendingRecipientsStmt.all(campaignId, limit).map(toRecipient);
    },

    /**
     * @param {string} recipientId
     * @param {{ status: 'sent'|'failed', providerMessageId?: string|null, error?: string|null }} result
     */
    recordRecipientResult(recipientId, { status, providerMessageId = null, error = null }) {
      updateRecipientStmt.run(status, providerMessageId, error, now().toISOString(), recipientId);
    },

    /**
     * No-op while any recipient is still `pending`. Otherwise sets the
     * campaign's status to sent / partial / failed based on the mix.
     * @param {string} campaignId
     */
    recomputeCampaignStatus(campaignId) {
      const statuses = recipientStatusesStmt.all(campaignId).map((r) => r.status);
      if (statuses.length === 0) return;
      if (statuses.some((s) => s === 'pending')) return;

      const allSent = statuses.every((s) => s === 'sent');
      const allFailed = statuses.every((s) => s === 'failed');
      setCampaignStatusStmt.run(allSent ? 'sent' : allFailed ? 'failed' : 'partial', campaignId);
    },
  };
}
