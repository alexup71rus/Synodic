#!/usr/bin/env node

/** Собирает публичную конфигурацию расширения из примера и локальных override. */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};

for (const filename of ['.env.example', '.env', '.env.local']) {
  try {
    const source = await readFile(resolve(root, filename), 'utf8');
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error(`некорректная строка в ${filename}: ${rawLine}`);
      env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const serverUrl = process.env.SYNODIC_SERVER_URL || env.SYNODIC_SERVER_URL;
if (!serverUrl) throw new Error('не задан SYNODIC_SERVER_URL');

const parsedUrl = new URL(serverUrl);
if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
  throw new Error('SYNODIC_SERVER_URL должен быть публичным http(s)-адресом без логина и пароля');
}

const target = resolve(root, 'src/shared/config.js');
const publicUrl = parsedUrl.toString().replace(/\/$/, '');
const output = `/** Сгенерировано scripts/configure.mjs из .env. Не редактировать вручную. */\n` +
  `globalThis.SynodicConfig = Object.freeze({\n` +
  `  SERVER_URL: ${JSON.stringify(publicUrl)},\n` +
  `});\n`;

await writeFile(target, output);
console.log(`✓ сервер расширения: ${publicUrl}`);
