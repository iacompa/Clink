// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Builds Clink for every browser:
 *   dist/chrome/   (MV3 service worker)       + dist/clink-chrome-<v>.zip
 *   dist/firefox/  (MV3 event page)           + dist/clink-firefox-<v>.zip
 *   dist/safari/   (MV3, Safari-safe rules)   → feed to `npm run safari`
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateRulesets, RULESET_IDS } from './dnr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

const SHARED = ['shared/rules.js', 'shared/cleaner.js', 'shared/settings.js'];

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Clink — Clean Links',
    short_name: 'Clink',
    version: pkg.version,
    // App Store Connect rejects a Safari extension whose description is over 112 characters.
    description: 'Removes tracking tags (utm, fbclid, gclid…) from links and skips redirect trackers, without breaking links.',
    homepage_url: 'https://github.com/iacompa/Clink',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_title: 'Clink',
      default_popup: 'popup/popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' },
    },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    permissions: ['declarativeNetRequest', 'storage', 'webRequest'],
    host_permissions: ['<all_urls>'],
    content_scripts: [{
      matches: ['<all_urls>'],
      js: [...SHARED, 'content.js'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true,
    }],
    declarative_net_request: {
      rule_resources: RULESET_IDS.map((id) => ({ id, enabled: true, path: `rules/${id}.json` })),
    },
  };

  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '116';
  } else if (target === 'firefox') {
    m.background = { scripts: [...SHARED, 'background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'clink@iacompa.com',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  } else if (target === 'safari') {
    // iOS/iPadOS only run non-persistent backgrounds (the converter insists on
    // the explicit flag), and Safari has no webRequest for those — so Link
    // Guard is unavailable there.
    m.background = { scripts: [...SHARED, 'background.js'], persistent: false };
    m.permissions = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'storage'];
    // Keys Safari doesn't support (the Xcode converter warns about them).
    m.options_ui = { page: m.options_ui.page };
    delete m.content_scripts[0].match_about_blank;
  }
  if (m.description.length > 112) throw new Error(`manifest description is ${m.description.length} characters; the App Store allows 112`);
  return m;
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(a, b);
    else await fs.copyFile(a, b);
  }
}

async function build(target) {
  const out = path.join(DIST, target);
  await fs.rm(out, { recursive: true, force: true });
  await copyDir(SRC, out);
  await fs.copyFile(path.join(ROOT, 'LICENSE'), path.join(out, 'ui', 'LICENSE.txt'));

  const flavor = target === 'safari' ? 'safari' : 'standard';
  const sets = generateRulesets(flavor);
  await fs.mkdir(path.join(out, 'rules'), { recursive: true });
  let total = 0;
  for (const id of RULESET_IDS) {
    await fs.writeFile(path.join(out, 'rules', `${id}.json`), JSON.stringify(sets[id]));
    total += sets[id].length;
  }
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2) + '\n');

  if (target !== 'safari') {
    const zip = path.join(DIST, `clink-${target}-${pkg.version}.zip`);
    await fs.rm(zip, { force: true });
    execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: out });
  }
  return { target, total };
}

await fs.mkdir(DIST, { recursive: true });
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'firefox', 'safari'];
for (const t of targets) {
  const { total } = await build(t);
  console.log(`✓ ${t.padEnd(8)} dist/${t}  (${total} network rules)`);
}
