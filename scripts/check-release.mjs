import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve('.');
config({ path: path.join(root, '.env'), quiet: true });
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
const source = `import {releaseChecks} from './apps/api/src/readiness.ts'; const checks=releaseChecks(); for(const check of checks)console.log('['+check.status+'] '+check.label+'：'+check.detail); if(checks.some(c=>c.status!=='PASS'))process.exitCode=1;`;
const child = spawn(process.execPath, [requireApi.resolve('tsx/cli'), '--eval', source], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on('exit', (code) => (process.exitCode = code || 0));
