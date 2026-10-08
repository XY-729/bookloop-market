import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Windows PostgreSQL binaries cannot live under a non-ASCII path. Cache an
// independent copy outside the workspace; never rename the checkout.
export async function localPostgres(options) {
  const db = new EmbeddedPostgres(options);
  if (process.platform !== 'win32') return db;
  const binaries = await import('@embedded-postgres/windows-x64');
  const native = path.dirname(path.dirname(binaries.postgres));
  const runtime = path.resolve(
    process.env.LOCALAPPDATA || os.tmpdir(),
    'bookloop-market',
    'runtime-18.4',
  );
  if (!existsSync(path.join(runtime, 'bin', 'postgres.exe'))) {
    await mkdir(runtime, { recursive: true });
    await cp(native, runtime, { recursive: true });
  }
  const run = (name, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(path.join(runtime, 'bin', `${name}.exe`), args, {
        cwd: runtime,
        windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(output) : reject(new Error(`${name} failed: ${output}`)),
      );
    });
  db.initialise = async () => {
    const passwordFile = path.join(os.tmpdir(), `bookloop-pg-${randomUUID()}`);
    try {
      await writeFile(passwordFile, options.password);
      await run('initdb', [
        `--pgdata=${options.databaseDir}`,
        `--username=${options.user}`,
        `--pwfile=${passwordFile}`,
        '--auth=scram-sha-256',
        '--locale=C',
        '--encoding=UTF8',
      ]);
    } finally {
      await unlink(passwordFile).catch(() => {});
    }
  };
  db.start = async () => {
    await new Promise((resolve, reject) => {
      const child = spawn(
        path.join(runtime, 'bin', 'postgres.exe'),
        ['-D', options.databaseDir, '-p', String(options.port), '-h', '127.0.0.1'],
        { cwd: runtime, windowsHide: true },
      );
      db.process = child;
      let output = '';
      child.stderr.on('data', (chunk) => {
        output += chunk;
        if (output.includes('database system is ready to accept connections')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`PostgreSQL exited ${code}: ${output}`)));
    });
  };
  db.stop = async () => {
    if (!db.process) return;
    await run('pg_ctl', ['stop', '-D', options.databaseDir, '-m', 'fast', '-w']);
    db.process = undefined;
  };
  return db;
}
