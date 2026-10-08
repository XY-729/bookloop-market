import { cp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
async function copy(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await copy(file);
    else if (!file.endsWith('.ts'))
      await cp(file, path.join('dist', path.relative('src', file)), { recursive: true });
  }
}
await copy('src');
if (process.argv.includes('--production')) {
  if (
    !process.env.MINI_API_URL?.startsWith('https://') ||
    !/^wx[a-zA-Z0-9]{16}$/.test(process.env.MINI_APP_ID || '')
  )
    throw new Error('Production build requires HTTPS MINI_API_URL and a valid MINI_APP_ID');
  await writeFile(
    'dist/config.js',
    `"use strict";exports.API_BASE_URL=${JSON.stringify(process.env.MINI_API_URL.replace(/\/$/, ''))};exports.DEV_LOGIN_ENABLED=false;exports.DEV_LOGIN_SECRET="";`,
  );
  await writeFile(
    'project.production.config.json',
    JSON.stringify(
      {
        appid: process.env.MINI_APP_ID,
        projectname: 'bookloop-mini',
        miniprogramRoot: 'dist/',
        compileType: 'miniprogram',
        setting: { es6: true, enhance: true, minified: true, urlCheck: true },
      },
      null,
      2,
    ),
  );
}
