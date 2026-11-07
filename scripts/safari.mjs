// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Packages Clink for Safari (macOS + iOS) as an Xcode project and compiles it.
 *
 *   npm run safari                    build dist/safari → sync into safari/ → compile (macOS + iOS Simulator)
 *   npm run safari -- --open          …and open the project in Xcode
 *   npm run safari -- --regenerate    recreate safari/ from scratch (overwrites Xcode customisations)
 *   npm run safari -- --no-build      only sync the extension files
 *   npm run safari -- --archive       archive signed builds for the App Store (macOS + iOS)
 *   npm run safari -- --upload        …and upload them to App Store Connect
 *   CLINK_BUNDLE_ID=com.you.Clink CLINK_TEAM_ID=ABCDE12345 npm run safari -- --regenerate
 *
 * Archiving signs with Xcode's automatic signing, so the Apple account for the
 * team must be signed in to Xcode (Settings → Accounts).
 *
 * The Xcode project in safari/ is generated once with Apple's
 * safari-web-extension-converter and then kept: set your signing team in
 * Xcode and it sticks. Every run copies the latest dist/safari build into it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { iconSvg, renderPngs } from './icon-svg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'safari');
const OUT = path.join(ROOT, 'safari');
const PROJ = path.join(OUT, 'Clink');
const XCODEPROJ = path.join(PROJ, 'Clink.xcodeproj');
const PBXPROJ = path.join(XCODEPROJ, 'project.pbxproj');
const EXT_RESOURCES = path.join(PROJ, 'Shared (Extension)', 'Resources');
const APP_ASSETS = path.join(PROJ, 'Shared (App)', 'Assets.xcassets');
const BUILD = path.join(OUT, 'build');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const BUNDLE_ID = process.env.CLINK_BUNDLE_ID || 'com.iacompa.clink';
const TEAM_ID = process.env.CLINK_TEAM_ID || 'L98358T6WZ'; // IA COMPA LLC
const COPYRIGHT = 'Copyright © 2026 IA COMPA LLC. Free software under the GNU GPL v3 or later.';
// App Store builds need a build number that only goes up: the number of commits.
const BUILD_NUMBER = (() => {
  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return '1';
  }
})();

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
const step = (msg) => console.log(`\n▸ ${msg}`);

if (process.platform !== 'darwin') {
  console.error('Building for Safari needs macOS with Xcode installed.');
  process.exit(1);
}
if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('dist/safari is missing — run `npm run build` first (or use `npm run safari`).');
  process.exit(1);
}
try {
  execFileSync('xcrun', ['--find', 'safari-web-extension-converter'], { stdio: 'ignore' });
} catch (_) {
  console.error('safari-web-extension-converter not found. Install Xcode from the App Store, then run:\n  sudo xcode-select -s /Applications/Xcode.app');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Generate the Xcode project (once)
// ---------------------------------------------------------------------------

if (args.has('--regenerate') || !fs.existsSync(XCODEPROJ)) {
  step(`Generating Xcode project (bundle id ${BUNDLE_ID})`);
  await fsp.rm(PROJ, { recursive: true, force: true });
  run('xcrun', ['safari-web-extension-converter', DIST,
    '--project-location', OUT, '--app-name', 'Clink', '--bundle-identifier', BUNDLE_ID,
    '--swift', '--copy-resources', '--no-open', '--no-prompt', '--force']);
  try {
    await appIcons();
  } catch (e) {
    await fsp.rm(PROJ, { recursive: true, force: true }); // don't leave a half-made project behind
    throw e;
  }
} else {
  step('Rendering app icons');
  await appIcons();
}

// ---------------------------------------------------------------------------
// 2. Sync the latest extension build into the project
// ---------------------------------------------------------------------------

step('Syncing dist/safari into the Xcode project');
const pbx = fs.readFileSync(PBXPROJ, 'utf8');
const entries = fs.readdirSync(DIST).filter((n) => !n.startsWith('.'));
// Top-level files/folders are individual references in the project; anything
// new needs the project regenerated, or Xcode would silently leave it out.
const unknown = entries.filter((n) => !pbx.includes(`/* ${n} in Resources */`));
if (unknown.length) {
  console.error(`The extension has new top-level files the Xcode project doesn't know: ${unknown.join(', ')}.\nRun: npm run safari -- --regenerate`);
  process.exit(1);
}
await fsp.mkdir(EXT_RESOURCES, { recursive: true }); // not in git — filled from dist/safari
for (const n of fs.readdirSync(EXT_RESOURCES)) await fsp.rm(path.join(EXT_RESOURCES, n), { recursive: true, force: true });
for (const n of entries) await fsp.cp(path.join(DIST, n), path.join(EXT_RESOURCES, n), { recursive: true });
// Keep the app's version in step with package.json, and keep the project in the
// Xcode 16 file format (77): newer Xcodes save a format older ones can't open,
// and the project uses nothing newer.
fs.writeFileSync(PBXPROJ, pbx
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${pkg.version};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${BUILD_NUMBER};`)
  .replace(/INFOPLIST_KEY_NSHumanReadableCopyright = [^;]*;/g, `INFOPLIST_KEY_NSHumanReadableCopyright = "${COPYRIGHT}";`)
  .replace(/objectVersion = (\d+);/, (m, v) => (Number(v) > 77 ? 'objectVersion = 77;' : m)));
// The app's own window: our page (safari/app) instead of the converter's
// placeholder, a roomier Mac window, and scrolling on small iPhones.
const APP_RES = path.join(PROJ, 'Shared (App)', 'Resources');
await fsp.cp(path.join(OUT, 'app', 'Main.html'), path.join(APP_RES, 'Base.lproj', 'Main.html'));
for (const f of ['Style.css', 'Script.js']) await fsp.cp(path.join(OUT, 'app', f), path.join(APP_RES, f));
const patch = (file, from, to) => {
  const f = path.join(PROJ, file);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll(from, to));
};
patch('macOS (App)/Base.lproj/Main.storyboard', 'width="425" height="325"', 'width="560" height="580"');
patch('Shared (App)/ViewController.swift', 'scrollView.isScrollEnabled = false', 'scrollView.isScrollEnabled = true');

// What App Store Connect asks for: a Mac app category, and the export-compliance
// answer (Clink uses no encryption of its own).
const plist = (file, key, type, value) => {
  const f = path.join(PROJ, file);
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, f], { stdio: 'ignore' });
  } catch (_) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, f], { stdio: 'ignore' });
  }
};
for (const app of ['iOS (App)/Info.plist', 'macOS (App)/Info.plist']) plist(app, 'ITSAppUsesNonExemptEncryption', 'bool', 'false');
plist('macOS (App)/Info.plist', 'LSApplicationCategoryType', 'string', 'public.app-category.productivity');
console.log(`  ${entries.length} items → ${path.relative(ROOT, EXT_RESOURCES)}  (v${pkg.version}, build ${BUILD_NUMBER})`);

// ---------------------------------------------------------------------------
// 3. Compile
// ---------------------------------------------------------------------------

if (!args.has('--no-build')) {
  const common = ['-project', XCODEPROJ, '-configuration', 'Release', '-derivedDataPath', BUILD, '-quiet'];
  step('Compiling for macOS (signed to run locally)');
  run('xcodebuild', [...common, '-scheme', 'Clink (macOS)', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual',
    'DEVELOPMENT_TEAM=', 'build']);
  const app = path.join(BUILD, 'Build', 'Products', 'Release', 'Clink.app');
  console.log(`  ✓ ${path.relative(ROOT, app)}`);

  const sdks = execFileSync('xcodebuild', ['-showsdks'], { encoding: 'utf8' });
  if (/iphonesimulator/.test(sdks)) {
    step('Compiling for the iOS Simulator');
    run('xcodebuild', [...common, '-scheme', 'Clink (iOS)', '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', 'CODE_SIGNING_ALLOWED=NO', 'build']);
    console.log('  ✓ iOS build OK');
  } else {
    console.log('\n(iOS Simulator SDK not installed — skipped the iOS build.)');
  }

  console.log(`
Done. To try Clink in Safari on this Mac:
  1. Safari → Settings → Advanced → turn on “Show features for web developers”.
  2. Safari → Settings → Developer → turn on “Allow unsigned extensions” (asks for your password; resets when Safari quits).
  3. open "${path.relative(ROOT, app)}"   (launch the app once — it registers the extension)
  4. Safari → Settings → Extensions → enable Clink, then “Always Allow on Every Website”.
To ship it (App Store / iPhone): npm run safari -- --open, set your Team under Signing & Capabilities, then Product → Archive.`);
}

// ---------------------------------------------------------------------------
// 4. App Store: archive (and optionally upload) signed builds
// ---------------------------------------------------------------------------

if (args.has('--archive') || args.has('--upload')) {
  const upload = args.has('--upload');
  const options = path.join(BUILD, 'ExportOptions.plist');
  await fsp.mkdir(BUILD, { recursive: true });
  fs.writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${upload ? 'upload' : 'export'}</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>`);
  // --only=ios or --only=macos archives one platform.
  const only = [...args].find((a) => a.startsWith('--only='))?.slice(7).toLowerCase();
  for (const [platform, scheme] of [['macOS', 'Clink (macOS)'], ['iOS', 'Clink (iOS)']]) {
    if (only && only !== platform.toLowerCase()) continue;
    const archive = path.join(BUILD, `Clink-${platform}.xcarchive`);
    step(`Archiving for ${platform} (team ${TEAM_ID})`);
    run('xcodebuild', ['-project', XCODEPROJ, '-scheme', scheme, '-configuration', 'Release',
      '-destination', `generic/platform=${platform}`, '-archivePath', archive, '-allowProvisioningUpdates',
      `DEVELOPMENT_TEAM=${TEAM_ID}`, 'CODE_SIGN_STYLE=Automatic',
      // iOS: archive unsigned and let the export sign it for the App Store. Automatic signing
      // would first sign for development, which needs a registered test device — an
      // App Store-only team may have none.
      ...(platform === 'iOS' ? ['CODE_SIGNING_ALLOWED=NO'] : []),
      '-quiet', 'archive']);
    step(upload ? `Uploading the ${platform} build to App Store Connect` : `Exporting the ${platform} build`);
    run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', options,
      '-exportPath', path.join(BUILD, `export-${platform}`), '-allowProvisioningUpdates']);
  }
  console.log(upload ? '\n✓ Uploaded. The builds appear in App Store Connect → TestFlight after processing.' : '\n✓ Exported to safari/build/export-*');
}

if (args.has('--open')) run('open', [XCODEPROJ]);

// ---------------------------------------------------------------------------

/** Crisp app icons rendered from the vector source (the converter upscales the 128px icon). */
async function appIcons() {
  const set = path.join(APP_ASSETS, 'AppIcon.appiconset');
  const contents = JSON.parse(fs.readFileSync(path.join(set, 'Contents.json'), 'utf8'));
  const jobs = new Map();
  for (const img of contents.images) {
    if (!img.filename) continue;
    const base = Number(img.size.split('x')[0]);
    const size = Math.round(base * (img.scale ? parseFloat(img.scale) : 1)); // scale is "2x"
    const variant = img.platform === 'ios' || img.idiom !== 'mac' ? 'ios' : 'mac';
    jobs.set(img.filename, { size, svg: iconSvg({ size, variant }), file: path.join(set, img.filename), opaque: variant === 'ios' });
  }
  // The icon shown inside the app's own window.
  const large = path.join(PROJ, 'Shared (App)', 'Resources', 'Icon.png');
  jobs.set('Icon.png', { size: 256, svg: iconSvg({ size: 256, variant: 'mac' }), file: large });
  for (const dir of fs.readdirSync(path.join(APP_ASSETS, 'LargeIcon.imageset'))) {
    if (dir.endsWith('.png')) {
      const file = path.join(APP_ASSETS, 'LargeIcon.imageset', dir);
      const size = Number(execFileSync('sips', ['-g', 'pixelWidth', file], { encoding: 'utf8' }).match(/pixelWidth: (\d+)/)[1]);
      jobs.set(dir, { size, svg: iconSvg({ size, variant: 'mac' }), file });
    }
  }
  await renderPngs([...jobs.values()]);
  console.log(`  rendered ${jobs.size} app icons`);
}
