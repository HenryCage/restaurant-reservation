// http/routes/reservations.js - public reservation booking endpoint.

import express from 'express';
import { normalisePhone } from '../../phone.js';
import { sanitiseText } from '../../message.js';

/**
 * @param {import('../../tenants.js').Tenant} tenant
 * @param {import('../../config.js').Config} config
 */
function countryCodeFor(tenant, config) {
  return tenant.defaultCountryCode || config.defaultCountryCode;
}

/**
 * @param {import('../../tenants.js').Tenant} tenant
 * @param {import('../../config.js').Config} config
 * @param {string} phone
 */
function resolveRecipient(tenant, config, phone) {
  const override = config.effectiveGlobalTestNumber || tenant.testNumber || '';
  if (override) return normalisePhone(override, countryCodeFor(tenant, config)) || override;
  return phone;
}

/**
 * @param {string} iso
 * @returns {string}
 */
function formatReservationTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/**
 * @param {any} body
 * @param {import('../../tenants.js').Tenant[]} tenants
 */
function selectTenant(body, tenants) {
  const tenantId = typeof body?.tenantId === 'string' ? body.tenantId.trim() : '';
  if (tenantId !== '') {
    return tenants.find((t) => t.id === tenantId) ?? null;
  }
  if (tenants.length === 1) return tenants[0];
  return null;
}

/**
 * @param {import('../../tenants.js').Tenant} tenant
 * @param {any} reservation
 */
function buildConfirmationMessage(tenant, reservation) {
  const when = formatReservationTime(reservation.reservationTime);
  return (
    `Hi ${reservation.name}, your reservation at ${tenant.name} for ${reservation.partySize} ` +
    `on ${when} is confirmed. Ref: ${reservation.id.slice(0, 8)}`
  );
}

/**
 * @param {{
 *   config: import('../../config.js').Config,
 *   contactsStore: ReturnType<typeof import('../../contacts.js').createContactsStore>,
 *   reservationsStore: ReturnType<typeof import('../../reservations.js').createReservationsStore>,
 *   registry: { load: () => import('../../tenants.js').Tenant[] },
 *   smsSenderFactory: { forTenant: (tenant: import('../../tenants.js').Tenant) => (to: string, message: string, opts: { senderId: string, channel?: string }) => Promise<{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }> },
 * }} deps
 */
export function createReservationsRoutes({ config, contactsStore, reservationsStore, registry, smsSenderFactory }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = req.body ?? {};
    const tenants = registry.load();

    if (tenants.length === 0) {
      res.status(503).json({ error: 'reservations are not available because no active tenant is configured' });
      return;
    }

    const tenant = selectTenant(body, tenants);
    if (!tenant) {
      res.status(400).json({
        error:
          tenants.length > 1
            ? 'tenantId is required when more than one active tenant is configured'
            : 'tenant not found',
      });
      return;
    }

    const name = sanitiseText(body.name, 80);
    if (name === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const rawPhone = body.phone;
    const countryCode =
      typeof body.countryCode === 'string' && body.countryCode.trim() !== ''
        ? body.countryCode
        : countryCodeFor(tenant, config);
    const phone = normalisePhone(rawPhone, countryCode);
    if (!phone) {
      res.status(400).json({ error: `invalid phone: ${rawPhone ?? ''}` });
      return;
    }

    try {
      const contact = contactsStore.upsertContact(tenant.id, { name, phone });
      if (!contact) {
        res.status(400).json({ error: `invalid phone: ${rawPhone ?? ''}` });
        return;
      }

      let reservation = reservationsStore.createReservation(tenant.id, {
        contactId: contact.id,
        name,
        phone,
        partySize: body.partySize,
        reservationTime: body.reservationTime,
        notes: body.notes,
      });

      const message = buildConfirmationMessage(tenant, reservation);
      const to = resolveRecipient(tenant, config, phone);
      const sendSms = smsSenderFactory.forTenant(tenant);

      let sendResult;
      try {
        sendResult = config.dryRun
          ? { ok: true, providerMessageId: 'dry-run' }
          : await sendSms(to, message, { senderId: tenant.senderId, channel: tenant.channel });
      } catch (err) {
        sendResult = { ok: false, error: err?.message ?? String(err) };
      }

      reservation = reservationsStore.recordSmsResult(tenant.id, reservation.id, {
        status: sendResult.ok ? (config.dryRun ? 'dry-run' : 'sent') : 'failed',
        error: sendResult.ok ? null : sendResult.error ?? 'unknown send error',
        providerMessageId: sendResult.providerMessageId ?? null,
      });

      res.status(201).json({
        reservation,
        sms: {
          status: reservation.smsStatus,
          error: reservation.smsError,
        },
      });
    } catch (err) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
