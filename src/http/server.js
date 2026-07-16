// http/server.js — Express app factory (Customer-auth spec).
//
// Builds the app; the caller decides when/how to .listen(), matching the
// rest of the codebase's create-then-caller-drives pattern (createProcessor,
// createCampaignScheduler).

import express from 'express';
import cors from 'cors';
import { createAuthRoutes } from './routes/auth.js';
import { createRateLimiter } from './rateLimiter.js';

/**
 * @param {{
 *   config: import('../config.js').Config,
 *   logger: import('../logger.js').Logger,
 *   authStore: ReturnType<typeof import('../auth.js').createAuthStore>,
 *   contactsStore?: ReturnType<typeof import('../contacts.js').createContactsStore>,
 *   campaignsStore?: ReturnType<typeof import('../campaigns.js').createCampaignsStore>,
 * }} deps
 */
export function createHttpServer({ config, logger, authStore, contactsStore, campaignsStore }) {
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

  // contactsStore/campaignsStore routes are mounted once their route files
  // exist (kept optional here so this file is usable before that lands).

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
