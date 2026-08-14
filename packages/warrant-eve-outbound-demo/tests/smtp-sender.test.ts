import { describe, it, expect, vi } from 'vitest';
import { buildSmtpSender, smtpTransportOptions } from '../src/smtp-sender.js';
import type { MailMessage, MailTransport } from '../src/smtp-sender.js';

function fakeTransport(impl?: (m: MailMessage) => Promise<{ messageId?: unknown }>) {
  const calls: MailMessage[] = [];
  const transport: MailTransport = {
    async sendMail(m) {
      calls.push(m);
      return impl ? impl(m) : { messageId: '<abc@proton>' };
    },
  };
  return { transport, calls };
}

function sender(over: Partial<Parameters<typeof buildSmtpSender>[0]> = {}) {
  const { transport, calls } = fakeTransport();
  return {
    calls,
    s: buildSmtpSender({
      host: 'smtp.protonmail.ch', port: 587, user: 'u', password: 't',
      from: 'ceremony@example.com', allowedRecipients: ['idris@example.com'],
      transport, ...over,
    }),
  };
}

const GOOD = { to: 'idris@example.com', subject: 'hello', body: 'text' };

describe('buildSmtpSender', () => {
  it('sends a well formed message and returns the transport messageId', async () => {
    const { s, calls } = sender();
    const r = await s.send(GOOD);
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ messageId: '<abc@proton>' });
    expect(calls).toEqual([
      { from: 'ceremony@example.com', to: 'idris@example.com', subject: 'hello', text: 'text' },
    ]);
  });

  // The positive case is load-bearing: a stricter-than-intended parser would pass every negative
  // test in this file while sending nothing at all.
  it('passes the body through as text without re-templating it', async () => {
    const { s, calls } = sender();
    const body = 'line one\n\nline two with a "quote" and a <tag>';
    await s.send({ ...GOOD, body });
    expect(calls[0]!.text).toBe(body);
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['missing to', { subject: 's', body: 'b' }],
    ['missing subject', { to: 'idris@example.com', body: 'b' }],
    ['missing body', { to: 'idris@example.com', subject: 's' }],
    ['empty to', { to: '', subject: 's', body: 'b' }],
    ['wrong types', { to: 1, subject: 2, body: 3 }],
  ])('refuses params that are %s', async (_label, params) => {
    const { s, calls } = sender();
    const r = await s.send(params);
    expect(r.error?.code).toBe('smtp_params_invalid');
    expect(calls).toHaveLength(0);
  });

  // strict(): an unexpected key means the drainer handed over a shape this sender was not built
  // for. Silently sending the recognised subset would deliver an email nobody's warrant covers.
  it('refuses an unexpected extra key rather than sending a subset of it', async () => {
    const { s, calls } = sender();
    const r = await s.send({ ...GOOD, bcc: 'someone@else.com' });
    expect(r.error?.code).toBe('smtp_params_invalid');
    expect(calls).toHaveLength(0);
  });

  it('refuses a recipient outside the allowlist', async () => {
    const { s, calls } = sender();
    const r = await s.send({ ...GOOD, to: 'stranger@example.com' });
    expect(r.error?.code).toBe('recipient_not_allowed');
    expect(calls).toHaveLength(0);
  });

  it('matches the allowlist case insensitively and ignores surrounding space', async () => {
    const { s, calls } = sender();
    expect((await s.send({ ...GOOD, to: '  IDRIS@Example.COM ' })).error).toBeNull();
    expect(calls).toHaveLength(1);
  });

  // Normalizing the ALLOWLIST is a separate guard from normalizing the recipient, and the test
  // above cannot see it: its allowlist is already lowercase. loadCeremonyConfig happens to
  // normalize too, so only a caller constructing this sender directly reaches this path, which is
  // exactly the caller who would otherwise get a silent recipient_not_allowed on a valid address.
  it('normalizes the ALLOWLIST entries too, not just the recipient', async () => {
    const { transport, calls } = fakeTransport();
    const s = buildSmtpSender({
      host: 'h', port: 587, user: 'u', password: 't', from: 'f@x.io',
      allowedRecipients: ['  Idris@Example.COM  '], transport,
    });
    expect((await s.send(GOOD)).error).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('does not treat the allowlist as a prefix or substring match', async () => {
    const { s } = sender();
    for (const to of ['idris@example.com.evil.net', 'xidris@example.com', 'idris@example.co']) {
      expect((await s.send({ ...GOOD, to })).error?.code).toBe('recipient_not_allowed');
    }
  });

  it('refuses to fabricate a messageId when the transport returns none', async () => {
    const { transport } = fakeTransport(async () => ({}));
    const s = buildSmtpSender({
      host: 'h', port: 587, user: 'u', password: 't', from: 'f@x.io',
      allowedRecipients: ['idris@example.com'], transport,
    });
    const r = await s.send(GOOD);
    expect(r.error?.code).toBe('smtp_no_message_id');
  });

  it.each([['blank', '   '], ['not a string', 42]])
    ('refuses a messageId that is %s', async (_label, id) => {
      const { transport } = fakeTransport(async () => ({ messageId: id }));
      const s = buildSmtpSender({
        host: 'h', port: 587, user: 'u', password: 't', from: 'f@x.io',
        allowedRecipients: ['idris@example.com'], transport,
      });
      expect((await s.send(GOOD)).error?.code).toBe('smtp_no_message_id');
    });

  it('turns a transport throw into a typed err rather than rejecting', async () => {
    const transport: MailTransport = {
      sendMail: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    const s = buildSmtpSender({
      host: 'h', port: 587, user: 'u', password: 't', from: 'f@x.io',
      allowedRecipients: ['idris@example.com'], transport,
    });
    const r = await s.send(GOOD);
    expect(r.error?.code).toBe('smtp_send_failed');
    expect(r.error!.message).toContain('ECONNREFUSED');
  });

  // The drainer records action.outcome{failed} from an err and never retries the spent nonce.
  // A THROW escaping send() would instead propagate out of drainOutbox and leave no outcome at all.
  it('never throws out of send, whatever the transport does', async () => {
    const transport: MailTransport = {
      sendMail: async () => { throw 'a bare string, not an Error'; },
    };
    const s = buildSmtpSender({
      host: 'h', port: 587, user: 'u', password: 't', from: 'f@x.io',
      allowedRecipients: ['idris@example.com'], transport,
    });
    await expect(s.send(GOOD)).resolves.toMatchObject({ error: { code: 'smtp_send_failed' } });
  });
});

// ── The transport's TLS posture ───────────────────────────────────────────────────────────────
//
// Every other test in this file injects `opts.transport`, so the options actually handed to
// nodemailer were the one part of this module nothing could observe. That is where the downgrade
// hole was: without `requireTLS`, port 587 upgrades via STARTTLS only if the server offers it and
// sends AUTH in cleartext if it does not.
describe('smtpTransportOptions: TLS is required, never opportunistic', () => {
  const base = {
    host: 'smtp.example.test',
    user: 'agent@example.test',
    password: 'token',
    from: 'agent@example.test',
    allowedRecipients: ['ok@example.test'],
  };

  it('requires TLS on 587, where secure is false and STARTTLS would otherwise be optional', () => {
    const o = smtpTransportOptions({ ...base, port: 587 });
    expect(o.secure).toBe(false);
    // The assertion this file exists for. Drop `requireTLS` and a server that does not advertise
    // STARTTLS gets the token in the clear.
    expect(o.requireTLS).toBe(true);
  });

  it('uses implicit TLS on 465, and still requires it', () => {
    const o = smtpTransportOptions({ ...base, port: 465 });
    expect(o.secure).toBe(true);
    expect(o.requireTLS).toBe(true);
  });

  it('never produces a configuration that can transmit credentials without TLS', () => {
    // Not vacuous: every port a deployment might plausibly choose, including the plaintext one.
    for (const port of [25, 465, 587, 2465, 2525, 2587]) {
      const o = smtpTransportOptions({ ...base, port });
      expect(o.secure || o.requireTLS).toBe(true);
    }
  });

  it('passes host, port and auth through unchanged: the provider is a deployment choice', () => {
    const o = smtpTransportOptions({ ...base, host: 'smtp.protonmail.ch', port: 587 });
    expect(o.host).toBe('smtp.protonmail.ch');
    expect(o.port).toBe(587);
    expect(o.auth).toEqual({ user: 'agent@example.test', pass: 'token' });
  });
});
