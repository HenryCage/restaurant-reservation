// index.js — entry point: load config, wire dependencies, start the scheduler (spec §11).
//
// The processor is single-flight, so an overrunning tick simply causes the next
// interval fire to be skipped rather than overlapping. Process-level handlers log
// and exit on fatal errors so a supervisor (systemd/PM2/container) can restart.

import 'dotenv/config';
import { loadConfig, describeConfig } from './config.js';
import { createLogger } from './logger.js';
import { createTenantRegistry } from './tenants.js';
import { createSheetsClient } from './sheets.js';
import { createSmsSender } from './sms/index.js';
import { createProcessor } from './processor.js';

function main() {
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error('startup aborted — ' + (err?.message ?? String(err)));
    process.exit(1);
    return;
  }

  // Effective-mode banner (secret-free) + loud warnings for risky modes.
  logger.info('SMS Dispatch MVP starting - ' + describeConfig(config));
  if (config.dryRun) logger.warn('DRY_RUN enabled: no real SMS will be sent (rows are still marked)');
  if (config.testOverrideActive) {
    logger.warn(`TEST ROUTING ACTIVE: every message goes to ${config.globalTestNumber} (NODE_ENV=${config.nodeEnv})`);
  }
  if (config.globalTestNumberIgnored) {
    logger.warn('GLOBAL_TEST_NUMBER is set but IGNORED because NODE_ENV=production');
  }

  const registry = createTenantRegistry({ filePath: config.tenantsFile, logger });
  const sheets = createSheetsClient(config);
  const sendSms = createSmsSender(config);
  const processor = createProcessor({ config, logger, registry, sheets, sendSms });

  // Fail loudly and exit so a supervisor can restart from a clean state.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection — exiting for supervisor restart', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException — exiting for supervisor restart', { error: err?.message ?? String(err) });
    process.exit(1);
  });

  const intervalMs = config.pollIntervalSeconds * 1000;
  logger.info(`scheduler started: polling every ${config.pollIntervalSeconds}s`);

  const tick = () => {
    processor.run().catch((err) => logger.error('tick failed', { error: err?.message ?? String(err) }));
  };

  tick(); // run immediately, then on the interval
  const timer = setInterval(tick, intervalMs);

  const shutdown = (signal) => {
    logger.info(`received ${signal}, shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
