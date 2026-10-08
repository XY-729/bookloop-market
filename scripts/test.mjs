import { localPostgres } from './embedded-runtime.mjs';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve('.');
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
const databaseDir = path.resolve(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'bookloop-market',
  'test-postgres',
);
const databaseName = `market_test_${Date.now()}`;
const port = 55433;
const cluster = await localPostgres({
  databaseDir,
  user: 'market',
  password: 'market_local_only',
  port,
  persistent: true,
  initdbFlags: ['--locale=C', '--encoding=UTF8'],
  onLog: () => {},
  onError: console.error,
});
if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await cluster.initialise();
await cluster.start();
const client = new pg.Client({
  host: '127.0.0.1',
  port,
  user: 'market',
  password: 'market_local_only',
  database: 'postgres',
});
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: `postgresql://market:market_local_only@127.0.0.1:${port}/${databaseName}?schema=public`,
  JWT_SECRET: 'test-only-jwt-secret-with-at-least-32-characters',
  MEDIA_SIGNING_SECRET: 'test-only-media-secret-with-at-least-32-characters',
  DEV_LOGIN_ENABLED: 'true',
  DEV_LOGIN_SECRET: 'local-development-only',
  PAYMENT_PROVIDER: 'mock',
  WORKER_DISABLED: 'true',
  STORAGE_DRIVER: 'local',
  STORAGE_PATH: path.resolve('.local', databaseName, 'media'),
};
const run = (args, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code || 0));
  });
let code = 1;
try {
  await client.connect();
  await client.query(`CREATE DATABASE "${databaseName}"`);
  const migrated = await run([
    requireApi.resolve('prisma/build/index.js'),
    'migrate',
    'deploy',
    '--schema',
    'apps/api/prisma/schema.prisma',
  ]);
  if (migrated !== 0) throw new Error('Test database migration failed');
  code = await run(
    [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run'],
    path.join(root, 'apps/api'),
  );
} finally {
  if (/^market_test_\d+$/.test(databaseName)) {
    await client
      .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [
        databaseName,
      ])
      .catch(() => {});
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
  }
  await client.end().catch(() => {});
  await cluster.stop();
}
process.exitCode = code;
