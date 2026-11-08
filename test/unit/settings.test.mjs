// SPDX-License-Identifier: GPL-3.0-or-later
// Settings are saved by read → change → write. Changes made in quick
// succession (several paused sites, two switches) must all be kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadSettings() {
  // Browser storage is asynchronous: every read and write takes a moment.
  let stored = {};
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 5));
  const chrome = {
    storage: {
      local: {
        get: async (key) => later({ [key]: structuredClone(stored[key]) }),
        set: async (obj) => { await later(); stored = { ...stored, ...structuredClone(obj) }; },
      },
    },
  };
  const ctx = vm.createContext({ chrome, structuredClone, setTimeout, console });
  ctx.globalThis = ctx;
  vm.runInContext(await fs.readFile(path.join(ROOT, 'src/shared/settings.js'), 'utf8'), ctx);
  return { S: ctx.ClinkSettings, stored: () => stored.settings };
}

test('quick successive settings changes are all kept', async () => {
  const { S, stored } = await loadSettings();
  await Promise.all(['example.com', 'news.example.org', 'shop.test.example'].map((h) =>
    S.update((s) => { s.pausedSites.push(h); })));
  assert.deepEqual(stored().pausedSites, ['example.com', 'news.example.org', 'shop.test.example']);

  await Promise.all([
    S.update((s) => { s.categories.strict = true; }),
    S.update((s) => { s.categories.affiliate = false; }),
  ]);
  assert.equal(stored().categories.strict, true);
  assert.equal(stored().categories.affiliate, false);
  assert.equal(stored().pausedSites.length, 3);
});

test('a failed change does not block later ones', async () => {
  const { S, stored } = await loadSettings();
  await assert.rejects(S.update(() => { throw new Error('boom'); }));
  await S.update((s) => { s.pausedSites.push('example.com'); });
  assert.deepEqual(stored().pausedSites, ['example.com']);
});
