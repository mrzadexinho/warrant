// smtp-sender.ts: the real MTA behind the governed drainer (design spec section 8 step 5, section 9
// "Side effect" row). It is a Sender<unknown>, which is deliberate: the drainer hands it the EXACT
// object it hashed and compared against warrant.action.paramsHash, with no narrowing, re-render or
// re-template in between. All validation happens HERE, after the hash check, so the bytes that were
// hashed are the bytes that reach SMTP.
//
// nodemailer is loaded through a dynamic import inside the default transport factory, never at
// module scope. Master contract C12 is the reason: warrant-pack-gtm's readFileSync at module scope
// did not survive eve's bundler and took `eve info` and `eve dev` down with it. Nothing in this file
// is imported by prod-deps.ts or by any agent/ module, so the drainer's SMTP stack stays out of the
// eve bundle entirely; the dynamic import is the second layer in case that ever changes.
//
// Two refusals return err rather than throwing, so the drainer records action.outcome{failed} and
// the spent nonce is never retried:
//  - params that do not parse as {to, subject, body}
//  - a recipient outside the ceremony allowlist (design spec section 14)
import { z } from 'zod';
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { Sender } from '@idriszade/warrant-eve';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** The slice of nodemailer's Transporter this module uses. Injected in tests. */
export interface MailTransport {
  sendMail(msg: MailMessage): Promise<{ messageId?: unknown }>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  allowedRecipients: readonly string[];
  transport?: MailTransport;
}

// strict(): an unexpected key means the drainer handed us something other than the email params
// this sender was built for. Refuse rather than send a subset of an unrecognised shape.
const ParamsSchema = z.object({
  to: z.string().min(1),
  subject: z.string(),
  body: z.string(),
}).strict();

/**
 * The transport configuration, as a pure function so the TLS posture is assertable without a
 * network. It was inline in `defaultTransport` and therefore covered by nothing: every test
 * injects `opts.transport`, so the options actually used against a real MTA were the one part of
 * this file no test could see.
 *
 * **`requireTLS` is the security control here, and its absence was a downgrade hole.**
 * `secure: true` (port 465) is implicit TLS and safe on its own. On **587** (Proton's SMTP
 * submission port, and Proton Mail Bridge's), `secure` is `false` and nodemailer's default
 * `requireTLS: false` means STARTTLS is *opportunistic*: it upgrades when the server advertises
 * STARTTLS, and **proceeds in cleartext when it does not**, sending `AUTH` credentials in the
 * clear. An in-path attacker strips the advertisement and reads the token; the client cannot tell
 * *TLS was negotiated* from *TLS was silently skipped*, which is this repo's recurring failure
 * shape arriving on the wire.
 *
 * With `requireTLS: true` a server that will not do STARTTLS is a connection error rather than a
 * quiet plaintext session. Deny-by-default, applied to the transport.
 *
 * Not added: an explicit `tls.minVersion`. Node already floors at TLSv1.2, so it would restate a
 * default rather than change one, and `rejectUnauthorized` stays at its secure default, which is
 * why Proton Mail **Bridge** (a localhost relay with a self-signed certificate) needs its own
 * configuration and is not silently accommodated here.
 */
export function smtpTransportOptions(opts: SmtpOptions): {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
} {
  return {
    host: opts.host,
    port: opts.port,
    // 465 is implicit TLS; 587 (Proton submission, Bridge) is STARTTLS.
    secure: opts.port === 465,
    // Never opportunistic. On 465 it is redundant; on 587 it is the whole guarantee.
    requireTLS: true,
    auth: { user: opts.user, pass: opts.password },
  };
}

async function defaultTransport(opts: SmtpOptions): Promise<MailTransport> {
  const nodemailer = await import('nodemailer');
  const createTransport = nodemailer.default?.createTransport ?? nodemailer.createTransport;
  return createTransport(smtpTransportOptions(opts)) as unknown as MailTransport;
}

// A generic SMTP sender: nodemailer talking SMTP AUTH to whatever host:port config.ts hands it.
// Nothing here validates or assumes a vendor: the provider is a deployment choice (an env var),
// not a code one. Proton is one option among many and reaches this sender through two different
// routes: Proton Mail Bridge (a local relay, host 127.0.0.1, STARTTLS on the Bridge's port) or
// Proton's own SMTP submission service (remote, requires a business-tier plan, a custom domain,
// and a per-address token). Any other provider that speaks SMTP (Resend, Postmark, SES, a
// self-hosted MTA) fits exactly the same way: point host/port/user/password at it.
export function buildSmtpSender(opts: SmtpOptions): Sender<unknown> {
  const allowed = new Set(opts.allowedRecipients.map((r) => r.trim().toLowerCase()));
  let transport: MailTransport | undefined = opts.transport;

  return {
    async send(params: unknown): Promise<Result<{ messageId: string }, WarrantError>> {
      const parsed = ParamsSchema.safeParse(params);
      if (!parsed.success) {
        return err({
          type: 'validation',
          code: 'smtp_params_invalid',
          message: `outbox params are not a sendable email: ${parsed.error.message}`,
        });
      }
      const msg = parsed.data;

      // An empty allowlist can never reach here: loadCeremonyConfig rejects it. This check is the
      // per-send half of the same guard, and it is what stops a policy-approved but mistargeted
      // ceremony run from reaching a real stranger's inbox.
      if (!allowed.has(msg.to.trim().toLowerCase())) {
        return err({
          type: 'validation',
          code: 'recipient_not_allowed',
          message: `recipient is outside the ceremony allowlist: ${msg.to}`,
        });
      }

      try {
        if (transport === undefined) transport = await defaultTransport(opts);
        const info = await transport.sendMail({
          from: opts.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.body,
        });
        // No fabricated identifier, for the same reason GatewerkGate.submit refuses to invent a
        // reviewId: this value goes into action.outcome and becomes part of the signed certificate.
        if (typeof info.messageId !== 'string' || info.messageId.trim() === '') {
          return err({
            type: 'transient',
            code: 'smtp_no_message_id',
            message: 'SMTP transport returned no messageId; delivery is unconfirmed',
          });
        }
        return ok({ messageId: info.messageId });
      } catch (e) {
        return err({
          type: 'transient',
          code: 'smtp_send_failed',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}
