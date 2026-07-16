// http/server.js — Express app factory (Customer-auth spec).
//
// Builds the app; the caller decides when/how to .listen(), matching the
// rest of the codebase's create-then-caller-drives pattern (createProcessor,
// createCampaignScheduler).

import express from 'express';
import cors from 'cors';
import { createAuthRoutes } from './routes/auth.js';
import { createContactsRoutes } from './routes/contacts.js';
import { createCampaignsRoutes } from './routes/campaigns.js';
import { createOrdersRoutes } from './routes/orders.js';
import { createRateLimiter } from './rateLimiter.js';
import { createRequireAuth } from './middleware/requireAuth.js';

/**
 * @param {{
 *   config: import('../config.js').Config,
 *   logger: import('../logger.js').Logger,
 *   authStore: ReturnType<typeof import('../auth.js').createAuthStore>,
 *   contactsStore: ReturnType<typeof import('../contacts.js').createContactsStore>,
 *   campaignsStore: ReturnType<typeof import('../campaigns.js').createCampaignsStore>,
 *   registry: { load: () => import('../tenants.js').Tenant[] },
 *   sheets: { readOrders: (sheetId: string, sheetName: string) => Promise<any> },
 * }} deps
 */
export function createHttpServer({ config, logger, authStore, contactsStore, campaignsStore, registry, sheets }) {
  const app = express();
  app.use(express.json());
  if (config.corsOrigin) {
    app.use(cors({ origin: config.corsOrigin, credentials: true }));
  }

  const rateLimiter = createRateLimiter({
    max: config.loginRateLimitMax,
    windowMinutes: config.loginRateLimitWindowMinutes,
  });

  app.use('/auth', createAuthRoutes({ authStore, config, rateLimiter }));

  // No exemptPaths: every /api/* route stays blocked by must_change_password.
  const apiRequireAuth = createRequireAuth({ authStore });
  app.use('/api/contacts', createContactsRoutes({ requireAuth: apiRequireAuth, contactsStore }));
  app.use('/api/campaigns', createCampaignsRoutes({ requireAuth: apiRequireAuth, campaignsStore }));
  app.use('/api/orders', createOrdersRoutes({ requireAuth: apiRequireAuth, registry, sheets }));

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    logger.error('http error', { error: err?.message ?? String(err) });
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
