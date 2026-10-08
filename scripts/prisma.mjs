import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
config({ path: path.join(root, '.env'), quiet: true });
const child = spawn(
  process.execPath,
  [
    requireApi.resolve('prisma/build/index.js'),
    ...process.argv.slice(2),
    '--schema',
    path.join(root, 'apps/api/prisma/schema.prisma'),
  ],
  { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true },
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
