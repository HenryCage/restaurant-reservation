import { describe, it, expect } from 'vitest';
import { createTermiiAdapter, classifyTermiiError } from '../src/sms/termii.js';
import { createAfricasTalkingAdapter, classifyAtRecipientStatus } from '../src/sms/africasTalking.js';
import { createSmsSender } from '../src/sms/index.js';

/** Build a fake fetch that returns a canned JSON response and records the call. */
function fakeFetch({ ok = true, status = 200, json = {} } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

describe('Termii adapter', () => {
  it('sends the correct payload and returns the message id on success', async () => {
    const fetchFn = fakeFetch({ json: { code: 'ok', message_id: 'tmx_1' } });
    const send = createTermiiAdapter({
      apiKey: 'KEY',
      baseUrl: 'https://acct.termii.com/',
      timeoutMs: 1000,
      fetchFn,
    });
    const res = await send('+2348012345678', 'hello', { senderId: 'SwiftLog', channel: 'dnd' });
    expect(res).toEqual({ ok: true, providerMessageId: 'tmx_1' });

    const { url, options } = fetchFn.calls[0];
    expect(url).toBe('https://acct.termii.com/api/sms/send');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      to: '2348012345678', // country code without "+"
      from: 'SwiftLog',
      sms: 'hello',
      type: 'plain',
      channel: 'dnd',
      api_key: 'KEY',
    });
  });

  it('classifies a rejected sender id as permanent', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 400, json: { message: 'Invalid Sender ID' } });
    const send = createTermiiAdapter({ apiKey: 'K', baseUrl: 'https://x', timeoutMs: 1000, fetchFn });
    const res = await send('+2348012345678', 'hi', { senderId: 'Bad', channel: 'dnd' });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(true);
  });

  it('treats a network throw and a 5xx as transient', async () => {
    const throwing = async () => {
      throw new Error('ECONNRESET');
    };
    const send1 = createTermiiAdapter({ apiKey: 'K', baseUrl: 'https://x', timeoutMs: 1000, fetchFn: throwing });
    expect((await send1('+2348012345678', 'hi', { senderId: 'S', channel: 'dnd' })).permanent).toBe(false);

    const send2 = createTermiiAdapter({
      apiKey: 'K',
      baseUrl: 'https://x',
      timeoutMs: 1000,
      fetchFn: fakeFetch({ ok: false, status: 503, json: {} }),
    });
    expect((await send2('+2348012345678', 'hi', { senderId: 'S', channel: 'dnd' })).permanent).toBe(false);
  });

  it('classifyTermiiError defaults to transient when unsure', () => {
    expect(classifyTermiiError(400, 'something weird')).toBe(false);
    expect(classifyTermiiError(429, 'rate limited')).toBe(false);
    expect(classifyTermiiError(400, 'invalid phone number')).toBe(true);
  });
});

describe("Africa's Talking adapter", () => {
  it('sends form body with enqueue and returns the message id on success', async () => {
    const fetchFn = fakeFetch({
      json: { SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'ATX_9' }] } },
    });
    const send = createAfricasTalkingAdapter({ apiKey: 'K', username: 'sandbox', timeoutMs: 1000, fetchFn });
    const res = await send('+2348012345678', 'hello', { senderId: 'LagosCour' });
    expect(res).toEqual({ ok: true, providerMessageId: 'ATX_9' });

    const { url, options } = fetchFn.calls[0];
    expect(url).toContain('sandbox.africastalking.com');
    const params = new URLSearchParams(options.body);
    expect(params.get('username')).toBe('sandbox');
    expect(params.get('to')).toBe('+2348012345678');
    expect(params.get('from')).toBe('LagosCour');
    expect(params.get('enqueue')).toBe('true');
    expect(options.headers.apiKey).toBe('K');
  });

  it('maps a blacklisted recipient to a permanent failure', async () => {
    const fetchFn = fakeFetch({
      json: { SMSMessageData: { Recipients: [{ status: 'UserInBlacklist' }] } },
    });
    const send = createAfricasTalkingAdapter({ apiKey: 'K', username: 'sandbox', timeoutMs: 1000, fetchFn });
    const res = await send('+2348012345678', 'hi', { senderId: 'S' });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(true);
  });

  it('treats an internal server error status as transient', async () => {
    const fetchFn = fakeFetch({
      json: { SMSMessageData: { Recipients: [{ status: 'InternalServerError' }] } },
    });
    const send = createAfricasTalkingAdapter({ apiKey: 'K', username: 'sandbox', timeoutMs: 1000, fetchFn });
    expect((await send('+2348012345678', 'hi', { senderId: 'S' })).permanent).toBe(false);
  });

  it('classifyAtRecipientStatus identifies permanent statuses', () => {
    expect(classifyAtRecipientStatus('InvalidPhoneNumber')).toBe(true);
    expect(classifyAtRecipientStatus('InsufficientBalance')).toBe(false);
  });
});

describe('createSmsSender (provider selector)', () => {
  const termiiConfig = {
    smsProvider: 'termii',
    termii: { apiKey: 'K', baseUrl: 'https://x' },
    africasTalking: { apiKey: '', username: '' },
    httpTimeoutMs: 1000,
  };

  it('routes to the configured provider and normalises success', async () => {
    const fetchFn = fakeFetch({ json: { code: 'ok', message_id: 'm1' } });
    const sendSms = createSmsSender(termiiConfig, { fetchFn });
    const res = await sendSms('+2348012345678', 'hi', { senderId: 'S', channel: 'dnd' });
    expect(res).toEqual({ ok: true, providerMessageId: 'm1' });
  });

  it('converts an adapter throw into a transient failure', async () => {
    const sendSms = createSmsSender(termiiConfig, {
      fetchFn: async () => {
        throw new Error('boom');
      },
    });
    const res = await sendSms('+2348012345678', 'hi', { senderId: 'S', channel: 'dnd' });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(false);
  });
});
