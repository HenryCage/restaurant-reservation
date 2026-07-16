// http/server.js — Express app factory (Customer-auth spec).
//
// Builds the app; the caller decides when/how to .listen(), matching the
// rest of the codebase's create-then-caller-drives pattern (createProcessor,
// createCampaignScheduler).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createAuthRoutes } from './routes/auth.js';
import { createContactsRoutes } from './routes/contacts.js';
import { createCampaignsRoutes } from './routes/campaigns.js';
import { createOrdersRoutes } from './routes/orders.js';
import { createTenantsRoutes } from './routes/tenants.js';
import { createUsersRoutes } from './routes/users.js';
import { createRateLimiter } from './rateLimiter.js';
import { createRequireAuth } from './middleware/requireAuth.js';
import { createRequireSuperadmin } from './middleware/requireSuperadmin.js';

// src/http/server.js -> ../../client/dist
const CLIENT_DIST_PATH = fileURLToPath(new URL('../../client/dist', import.meta.url));

/**
 * @param {{
 *   config: import('../config.js').Config,
 *   logger: import('../logger.js').Logger,
 *   authStore: ReturnType<typeof import('../auth.js').createAuthStore>,
 *   contactsStore: ReturnType<typeof import('../contacts.js').createContactsStore>,
 *   campaignsStore: ReturnType<typeof import('../campaigns.js').createCampaignsStore>,
 *   registry: ReturnType<typeof import('../tenants.js').createTenantRegistry>,
 *   sheets: { readOrders: (sheetId: string, sheetName: string) => Promise<any> },
 *   clientDistPath?: string,
 * }} deps
 */
export function createHttpServer({
  config,
  logger,
  authStore,
  contactsStore,
  campaignsStore,
  registry,
  sheets,
  clientDistPath = CLIENT_DIST_PATH,
}) {
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

  const requireSuperadmin = createRequireSuperadmin({ authStore });
  app.use('/api/tenants', createTenantsRoutes({ requireSuperadmin, registry }));
  app.use('/api/users', createUsersRoutes({ requireSuperadmin, authStore, registry }));

  if (config.isProduction) {
    app.use(express.static(clientDistPath));
    // A plain (unpathed) middleware, not a route pattern -- avoids any
    // Express-version-specific wildcard/path-to-regexp syntax entirely.
    // Only unmatched GETs outside /api and /auth fall through to the SPA
    // shell; anything under those keeps getting the JSON 404 below (they
    // already would have matched a real route above if one existed).
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/auth')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }

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
