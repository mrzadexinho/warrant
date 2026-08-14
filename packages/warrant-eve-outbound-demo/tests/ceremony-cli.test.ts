// Exit codes are the product surface an operator scripts against, and the master plan's execution
// log records that the verifier CLI once printed an authorization violation correctly and exited 0
// anyway, because every test asserted on stdout and none on the code. These spawn the real CLI.
//
// Nothing here reaches the network or a database: `keygen` is local, and the two refusals fire
// before any client is constructed. `drain` and a configured `preflight` are deliberately NOT
// exercised, because both act on a live deployment.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'ceremony-cli.ts');

interface Run { code: number; stdout: string; stderr: string }

function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx/esm', CLI, ...args],
      // A deliberately EMPTY ceremony environment unless a case supplies one, so a stray variable
      // in the developer's shell cannot turn a refusal case into a live call.
      { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('warrant-ceremony CLI', () => {
  it('exits 2 and prints usage with no subcommand', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage: warrant-ceremony');
    expect(r.stdout).toBe('');
  });

  it('exits 2 on an unknown subcommand rather than doing something adjacent', async () => {
    const r = await runCli(['preflightt']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage: warrant-ceremony');
  });

  it('keygen prints the public key and WITHHOLDS the private half by default', async () => {
    const r = await runCli(['keygen']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^public_key_hex=[0-9a-f]{64}\n$/);
    expect(r.stdout).not.toContain('PRIVATE');
    expect(r.stderr).toContain('private key withheld');
  });

  it('keygen --print-private emits the private half, and a different key each time', async () => {
    const a = await runCli(['keygen', '--print-private']);
    const b = await runCli(['keygen', '--print-private']);
    expect(a.code).toBe(0);
    expect(a.stdout).toMatch(/WARRANT_PRIVATE_KEY_HEX=[0-9a-f]{64}\n/);
    // A ceremony key that repeated across runs would be a fixed key with extra steps.
    expect(a.stdout).not.toBe(b.stdout);
  });

  it.each([['preflight'], ['drain']])(
    '%s exits 2 and refuses to act when WARRANT_CEREMONY is not 1',
    async (cmd) => {
      const r = await runCli([cmd]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('refusing to act on a live deployment');
    },
  );

  it.each([['preflight'], ['drain']])(
    '%s exits 1 and names every missing variable when the ceremony config is broken',
    async (cmd) => {
      // Ceremony ON, nothing else set: the config loader must refuse before any pool or fetch.
      const r = await runCli([cmd], { WARRANT_CEREMONY: '1' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('ceremony configuration rejected');
      expect(r.stderr).toContain('WARRANT_PRIVATE_KEY_HEX');
      expect(r.stderr).toContain('WARRANT_CEREMONY_ALLOWED_RECIPIENTS');
    },
  );

  it('refuses the published demo key even with everything else set', async () => {
    const r = await runCli(['preflight'], {
      WARRANT_CEREMONY: '1',
      WARRANT_PRIVATE_KEY_HEX: '22'.repeat(32),
      WARRANT_LEDGER_DATABASE_URL: 'postgresql://app@127.0.0.1:1/w',
      WARRANT_LEDGER_ADMIN_DATABASE_URL: 'postgresql://admin@127.0.0.1:1/w',
      WARRANT_LEDGER_APP_ROLE: 'warrant_app',
      GATEWERK_BASE_URL: 'https://gw.example.com',
      GATEWERK_API_KEY: 'gwk_x',
      GATEWERK_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
  GATEWERK_TEMPLATE_SLUG: 'warrant-outbound-email', // deliberately supplied: the loader refuses an absent or empty slug
    WARRANT_TRIGGER_SECRET: 'trigger-secret-0123456789abcdef',
      PUBLIC_BASE_URL: 'https://agent.example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'u@example.com',
      SMTP_PASSWORD: 'tok',
      WARRANT_CEREMONY_FROM: 'u@example.com',
      OPENAI_API_KEY: 'sk-test',
      WARRANT_CEREMONY_ALLOWED_RECIPIENTS: 'idris@example.com',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('published demo key');
  });
});
