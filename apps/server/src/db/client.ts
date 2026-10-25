import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import * as schema from './schema';

export const sqlClient = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} });
export const db = drizzle(sqlClient, { schema });

export type Db = PostgresJsDatabase<typeof schema>;
/** A transaction or the root db: repo functions accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;
export { schema };
