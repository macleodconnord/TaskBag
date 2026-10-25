import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://app:app@localhost:5432/app'),
  /** Public HTTPS origin, e.g. https://pm.corp.example — used for OIDC redirect, email links, Gitea webhook URL */
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  /** Comma-separated CIDRs/IPs of the upstream proxy; empty = trust nothing */
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  /** 32-byte key, base64 or hex. Encrypts integration secrets and TOTP secrets. */
  APP_ENCRYPTION_KEY: z.string().min(32),
  DATA_DIR: z.string().default('./data'),
  /** Show a "pick a user" login. Never enable in production. */
  DEV_LOGIN: bool.default(false),
  BREAKGLASS_ENABLED: bool.default(false),
  MAX_UPLOAD_MB: z.coerce.number().default(250),
  LOG_LEVEL: z.string().default('info'),
  /** Optional Entra seed values: copied into the credentials GUI on first boot only */
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_FROM: z.string().optional(),
  /** Disable background jobs (tests, one-off CLI) */
  JOBS_ENABLED: bool.default(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example.`);
  process.exit(1);
}
export const env = parsed.data;
export const isDev = env.NODE_ENV === 'development';
