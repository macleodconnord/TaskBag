import { hash } from '@node-rs/argon2'; // argon2id is the default algorithm
import { sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { db, sqlClient } from './db/client';
import { users } from './db/schema';
import { encrypt, randomToken } from './lib/crypto';

/**
 * pnpm cli <command>
 *   user:create-breakglass <email> [--totp]   create/reset the local break-glass admin
 *   user:set-owner <email>                    make an existing user the owner
 * Other modules add their commands below (e.g. import:clickup).
 */
type Command = (args: string[]) => Promise<void>;
export const commands: Record<string, Command> = {
  'user:create-breakglass': async ([email, ...flags]) => {
    if (!email) throw new Error('usage: user:create-breakglass <email> [--totp]');
    const password = randomToken(18);
    const passwordHash = await hash(password);
    let totpSecret: OTPAuth.Secret | null = null;
    if (flags.includes('--totp')) totpSecret = new OTPAuth.Secret({ size: 20 });
    await db.insert(users).values({
      email, displayName: 'Break-glass admin', role: 'admin', isBreakglass: true, passwordHash,
      totpSecretEnc: totpSecret ? encrypt(totpSecret.base32) : null,
    }).onConflictDoUpdate({
      target: sql`lower(${users.email})` as never,
      set: { passwordHash, isBreakglass: true, role: 'admin', isActive: true, totpSecretEnc: totpSecret ? encrypt(totpSecret.base32) : null },
    });
    console.log(`Break-glass admin: ${email}\nPassword: ${password}`);
    if (totpSecret) {
      const uri = new OTPAuth.TOTP({ issuer: 'Project App', label: email, secret: totpSecret }).toString();
      console.log(`TOTP secret: ${totpSecret.base32}\notpauth URI: ${uri}`);
    }
    console.log('Requires BREAKGLASS_ENABLED=true. Store these somewhere safe; they are not shown again.');
  },
  'user:set-owner': async ([email]) => {
    if (!email) throw new Error('usage: user:set-owner <email>');
    await db.transaction(async (tx) => {
      const r = await tx.update(users).set({ role: 'owner' }).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).returning();
      if (!r.length) throw new Error(`No user with email ${email}`);
      await tx.update(users).set({ role: 'admin' }).where(sql`role = 'owner' and id <> ${r[0].id}`);
    });
    console.log(`${email} is now the owner.`);
  },
};

const extraCommands: Array<() => Promise<Record<string, Command>>> = [];
/** Modules can contribute CLI commands lazily. */
export const registerCliCommands = (loader: () => Promise<Record<string, Command>>) => extraCommands.push(loader);
// import:clickup [--dry-run|--delta] (see modules/import/cli.ts)
registerCliCommands(async () => (await import('./modules/import/cli')).commands);

async function main() {
  const [name, ...args] = process.argv.slice(2);
  for (const load of extraCommands) Object.assign(commands, await load());
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    console.log(`Commands:\n  ${Object.keys(commands).join('\n  ')}`);
    process.exit(name ? 1 : 0);
  }
  await cmd(args);
}

main()
  .then(() => sqlClient.end())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await sqlClient.end();
    process.exit(1);
  });
