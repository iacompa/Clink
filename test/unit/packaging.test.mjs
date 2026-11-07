// SPDX-License-Identifier: GPL-3.0-or-later
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TARGETS = ['chrome', 'firefox', 'safari'];
let fixture;
let pkg;

before(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'clink-packaging-'));
  for (const entry of ['src', 'scripts', 'package.json', 'LICENSE']) {
    await fs.cp(path.join(ROOT, entry), path.join(fixture, entry), { recursive: true });
  }
  pkg = JSON.parse(await fs.readFile(path.join(fixture, 'package.json'), 'utf8'));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: fixture });
});

after(async () => {
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

async function manifest(target) {
  return JSON.parse(await fs.readFile(path.join(fixture, 'dist', target, 'manifest.json'), 'utf8'));
}

test('Safari declares the host-access permission needed by redirect rules', async () => {
  const safari = await manifest('safari');
  assert.ok(safari.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.ok(safari.permissions.includes('declarativeNetRequest'));
  assert.deepEqual(safari.host_permissions, ['<all_urls>']);
  assert.equal(safari.background.persistent, false);
  assert.ok(!safari.permissions.includes('webRequest'));
});

test('browser packages preserve identifiers, internal versions, and background behavior', async () => {
  for (const target of TARGETS) {
    const m = await manifest(target);
    assert.equal(m.version, pkg.version, target);
    if (target === 'chrome') {
      assert.equal(m.background.service_worker, 'background.js');
      assert.equal(m.minimum_chrome_version, '116');
    } else if (target === 'firefox') {
      assert.equal(m.browser_specific_settings.gecko.id, 'clink@iacompa.com');
      assert.ok(m.background.scripts.includes('background.js'));
    }
    if (target !== 'safari') {
      assert.deepEqual(m.permissions, ['declarativeNetRequest', 'storage', 'webRequest']);
    }
  }
  const project = await fs.readFile(path.join(ROOT, 'safari/Clink/Clink.xcodeproj/project.pbxproj'), 'utf8');
  const bundleIds = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
  assert.equal(bundleIds.length, 8);
  assert.deepEqual([...new Set(bundleIds)].sort(), ['com.iacompa.clink', 'com.iacompa.clink.Extension']);
});

test('every package includes the complete repository license and a source link', async () => {
  const license = await fs.readFile(path.join(ROOT, 'LICENSE'), 'utf8');
  for (const target of TARGETS) {
    const out = path.join(fixture, 'dist', target);
    assert.equal(await fs.readFile(path.join(out, 'ui/LICENSE.txt'), 'utf8'), license, target);
    const options = await fs.readFile(path.join(out, 'options/options.html'), 'utf8');
    assert.match(options, /href="https:\/\/github\.com\/iacompa\/Clink"[^>]*>Source code/);
    if (target !== 'safari') {
      const zip = path.join(fixture, 'dist', `clink-${target}-${pkg.version}.zip`);
      assert.equal(execFileSync('unzip', ['-p', zip, 'ui/LICENSE.txt'], { encoding: 'utf8' }), license, `${target} zip`);
    }
  }
});

// Execute each real UI script with a minimal browser/DOM boundary. The label
// assertions test the script's output, rather than matching its source text.
async function versionLabel(root, page, version) {
  const elements = new Map();
  const element = () => ({
    textContent: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    append() {}, replaceChildren() {}, addEventListener() {}, setAttribute() {},
  });
  const document = {
    body: element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    querySelectorAll: () => [],
  };
  const browser = {
    runtime: { getManifest: () => ({ version }), sendMessage: async () => ({}) },
    tabs: { query: async () => [] },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    permissions: { contains: async () => true },
  };
  const context = vm.createContext({ document, browser, location: { search: '', hash: '' }, URL, URLSearchParams });
  for (const script of ['shared/rules.js', 'shared/cleaner.js', 'shared/settings.js']) {
    vm.runInContext(await fs.readFile(path.join(root, script), 'utf8'), context, { filename: script });
  }
  await vm.runInContext(await fs.readFile(path.join(root, page, `${page}.js`), 'utf8'), context, { filename: `${page}.js` });
  return elements.get('version').textContent;
}

for (const [page, prefix] of [['popup', ''], ['options', 'Clink · ']]) {
  test(`${page} shows public versions without internal patch numbers`, async () => {
    for (const [internal, visible] of [['1.0.0', '1'], ['1.1.0', '1.1'], ['1.9.3', '1.9'], ['2.0.0', '2']]) {
      assert.equal(await versionLabel(path.join(ROOT, 'src'), page, internal), `${prefix}Version ${visible}`, internal);
    }
    for (const target of TARGETS) {
      assert.equal(await versionLabel(path.join(fixture, 'dist', target), page, pkg.version), `${prefix}Version 1`, target);
    }
  });
}
