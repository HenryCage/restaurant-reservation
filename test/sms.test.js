import { describe, it, expect } from 'vitest';
import { createTermiiAdapter, classifyTermiiError } from '../src/sms/termii.js';
import { createAfricasTalkingAdapter, classifyAtRecipientStatus } from '../src/sms/africasTalking.js';
import { createTwilioAdapter, classifyTwilioError } from '../src/sms/twilio.js';
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

describe('Twilio adapter', () => {
  it('sends the correct payload and auth header, returns the sid on success', async () => {
    const fetchFn = fakeFetch({ status: 201, json: { sid: 'SMxxxx', status: 'queued' } });
    const send = createTwilioAdapter({
      accountSid: 'ACxxxx',
      authToken: 'secret',
      fromNumber: '+15005550006',
      timeoutMs: 1000,
      fetchFn,
    });
    const res = await send('+2348012345678', 'hello');
    expect(res).toEqual({ ok: true, providerMessageId: 'SMxxxx' });

    const { url, options } = fetchFn.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxxx/Messages.json');
    expect(options.headers.Authorization).toBe('Basic ' + Buffer.from('ACxxxx:secret').toString('base64'));
    const body = new URLSearchParams(options.body);
    expect(body.get('To')).toBe('+2348012345678');
    expect(body.get('From')).toBe('+15005550006');
    expect(body.get('Body')).toBe('hello');
  });

  it('classifies a known permanent error code (invalid To number)', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 400, json: { code: 21211, message: 'Invalid To Number' } });
    const send = createTwilioAdapter({ accountSid: 'AC', authToken: 'x', fromNumber: '+1', timeoutMs: 1000, fetchFn });
    const res = await send('+1invalid', 'hi');
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(true);
  });

  it('defaults to transient on an unknown code, a 5xx, and a network throw', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 500, json: { code: 20500, message: 'Internal Error' } });
    const send1 = createTwilioAdapter({ accountSid: 'AC', authToken: 'x', fromNumber: '+1', timeoutMs: 1000, fetchFn });
    expect((await send1('+2348012345678', 'hi')).permanent).toBe(false);

    const throwing = async () => {
      throw new Error('ECONNRESET');
    };
    const send2 = createTwilioAdapter({ accountSid: 'AC', authToken: 'x', fromNumber: '+1', timeoutMs: 1000, fetchFn: throwing });
    const res2 = await send2('+2348012345678', 'hi');
    expect(res2.ok).toBe(false);
    expect(res2.permanent).toBe(false);
  });

  it('classifyTwilioError only flags known permanent codes', () => {
    expect(classifyTwilioError(21211)).toBe(true);
    expect(classifyTwilioError(21610)).toBe(true);
    expect(classifyTwilioError(20500)).toBe(false);
    expect(classifyTwilioError(undefined)).toBe(false);
  });
});

describe('createSmsSender (provider selector)', () => {
  const termiiConfig = {
    smsProvider: 'termii',
    termii: { apiKey: 'K', baseUrl: 'https://x' },
    africasTalking: { apiKey: '', username: '' },
    twilio: { accountSid: '', authToken: '', fromNumber: '' },
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

  it('routes to Twilio when configured', async () => {
    const twilioConfig = {
      smsProvider: 'twilio',
      termii: { apiKey: '', baseUrl: '' },
      africasTalking: { apiKey: '', username: '' },
      twilio: { accountSid: 'ACxxxx', authToken: 'secret', fromNumber: '+15005550006' },
      httpTimeoutMs: 1000,
    };
    const fetchFn = fakeFetch({ status: 201, json: { sid: 'SMxxxx' } });
    const sendSms = createSmsSender(twilioConfig, { fetchFn });
    const res = await sendSms('+2348012345678', 'hi', { senderId: 'S' });
    expect(res).toEqual({ ok: true, providerMessageId: 'SMxxxx' });
  });
});
