import { localPostgres } from './embedded-runtime.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const databaseDir =
  process.env.LOCAL_PG_PATH ||
  path.resolve(process.env.LOCALAPPDATA || os.tmpdir(), 'bookloop-market', 'postgres');
const db = await localPostgres({
  databaseDir,
  user: 'market',
  password: 'market_local_only',
  port: 55432,
  persistent: true,
  initdbFlags: ['--locale=C', '--encoding=UTF8'],
  onLog: () => {},
  onError: console.error,
});
if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await db.initialise();
await db.start();
const client = db.getPgClient();
await client.connect();
try {
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', ['market']);
  if (!exists.rowCount) await client.query('CREATE DATABASE "market"');
} finally {
  await client.end();
}
console.log('Local PostgreSQL ready at 127.0.0.1:55432. Ctrl+C to stop.');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await db.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 60000);
