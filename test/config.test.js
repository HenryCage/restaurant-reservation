import { describe, it, expect } from 'vitest';
import { loadConfig, describeConfig } from '../src/config.js';

/** Minimal valid env for the Termii provider. */
function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@project.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n',
    SMS_PROVIDER: 'termii',
    TERMII_API_KEY: 'tk_123',
    TERMII_BASE_URL: 'https://example.termii.com',
    ...overrides,
  };
}

describe('loadConfig — happy path', () => {
  it('parses a valid Termii config and applies defaults', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.smsProvider).toBe('termii');
    expect(cfg.defaultCountryCode).toBe('234');
    expect(cfg.pollIntervalSeconds).toBe(60);
    expect(cfg.sendDelayMs).toBe(400);
    expect(cfg.httpTimeoutMs).toBe(15000);
    expect(cfg.maxSendsPerTenantPerTick).toBe(50);
    expect(cfg.dryRun).toBe(false);
  });

  it('un-escapes the \\n sequences in the private key', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.google.privateKey).toContain('\n');
    expect(cfg.google.privateKey).not.toContain('\\n');
  });

  it('returns a frozen config object', () => {
    const cfg = loadConfig(baseEnv());
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

describe('loadConfig — validation', () => {
  it('collects all missing-Google errors in one throw', () => {
    const env = baseEnv();
    delete env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete env.GOOGLE_PRIVATE_KEY;
    expect(() => loadConfig(env)).toThrow(/GOOGLE_SERVICE_ACCOUNT_EMAIL[\s\S]*GOOGLE_PRIVATE_KEY/);
  });

  it('requires TERMII_BASE_URL when provider is termii', () => {
    const env = baseEnv();
    delete env.TERMII_BASE_URL;
    expect(() => loadConfig(env)).toThrow(/TERMII_BASE_URL/);
  });

  it('requires AT vars when provider is africastalking', () => {
    const env = baseEnv({ SMS_PROVIDER: 'africastalking', TERMII_API_KEY: '', TERMII_BASE_URL: '' });
    expect(() => loadConfig(env)).toThrow(/AT_API_KEY[\s\S]*AT_USERNAME/);
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig(baseEnv({ SMS_PROVIDER: 'twilio' }))).toThrow(/SMS_PROVIDER/);
  });

  it('rejects a non-integer numeric env var', () => {
    expect(() => loadConfig(baseEnv({ POLL_INTERVAL_SECONDS: 'soon' }))).toThrow(/POLL_INTERVAL_SECONDS/);
  });
});

describe('loadConfig — GLOBAL_TEST_NUMBER gating', () => {
  it('honors the override outside production', () => {
    const cfg = loadConfig(baseEnv({ NODE_ENV: 'development', GLOBAL_TEST_NUMBER: '+2348000000000' }));
    expect(cfg.testOverrideActive).toBe(true);
    expect(cfg.effectiveGlobalTestNumber).toBe('+2348000000000');
  });

  it('ignores the override in production and flags it', () => {
    const cfg = loadConfig(baseEnv({ NODE_ENV: 'production', GLOBAL_TEST_NUMBER: '+2348000000000' }));
    expect(cfg.testOverrideActive).toBe(false);
    expect(cfg.effectiveGlobalTestNumber).toBe('');
    expect(cfg.globalTestNumberIgnored).toBe(true);
  });
});

describe('describeConfig', () => {
  it('produces a secret-free one-line banner', () => {
    const banner = describeConfig(loadConfig(baseEnv()));
    expect(banner).toContain('provider=termii');
    expect(banner).not.toContain('tk_123');
    expect(banner).not.toContain('PRIVATE KEY');
  });
});
