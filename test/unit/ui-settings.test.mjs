// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Keep the production rules, settings queue, event handlers, and rendering.
// Only the DOM and browser storage boundary are supplied by this fixture.
async function loadUI(page, { linkGuard = true } = {}) {
  const elements = [];
  const ids = new Map();
  class Element extends EventTarget {
    constructor() {
      super();
      this.dataset = {};
      this.checked = false;
      this.children = [];
      this.textContent = '';
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => {
          const add = force ?? !classes.has(name);
          if (add) classes.add(name);
          else classes.delete(name);
          return add;
        },
      };
      elements.push(this);
    }
    append(...children) {
      for (const child of children) {
        if (child instanceof Element) child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) {
        if (child instanceof Element) child.parent = null;
      }
      this.children = [];
      this.append(...children);
    }
    setAttribute() {}
  }

  const html = await fs.readFile(path.join(ROOT, 'src', page, `${page}.html`), 'utf8');
  for (const [, attrs] of html.matchAll(/<[a-z][\w-]*\b([^>]*)>/gi)) {
    const id = attrs.match(/\bid="([^"]+)"/)?.[1];
    const setting = attrs.match(/\bdata-setting="([^"]+)"/)?.[1];
    if (!id && !setting) continue;
    const element = new Element();
    if (id) ids.set(id, element);
    if (setting) element.dataset.setting = setting;
  }
  const document = {
    body: new Element(),
    getElementById: (id) => {
      assert.ok(ids.has(id), `missing HTML element: ${id}`);
      return ids.get(id);
    },
    createElement: () => new Element(),
    querySelectorAll: (selector) => {
      const key = { '[data-category]': 'category', '[data-setting]': 'setting' }[selector];
      assert.ok(key, `unsupported selector: ${selector}`);
      return elements.filter((element) => element.dataset[key]);
    },
  };

  let stored = {};
  let holdStorage = false;
  const pending = [];
  const listeners = [];
  const storageCall = (method, run) => holdStorage
    ? new Promise((resolve) => pending.push({ method, release: () => resolve(run()) }))
    : Promise.resolve(run());
  const browser = {
    runtime: { getManifest: () => ({ version: '1.1' }), sendMessage: async () => ({}) },
    tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }] },
    storage: {
      local: {
        get: (key) => storageCall('get', () => ({ [key]: structuredClone(stored[key]) })),
        set: (values) => storageCall('set', () => {
          const changes = {};
          for (const [key, newValue] of Object.entries(values)) {
            changes[key] = { oldValue: stored[key], newValue: structuredClone(newValue) };
          }
          stored = { ...stored, ...structuredClone(values) };
          // A save can re-render a still-pending checkbox before its mutator runs.
          for (const listener of listeners) listener(changes, 'local');
        }),
      },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
    permissions: { contains: async () => true },
  };
  if (linkGuard) browser.webRequest = { onBeforeRedirect: {} };
  const context = vm.createContext({ document, browser, location: { search: '', hash: '' }, URL, URLSearchParams });
  for (const script of ['shared/rules.js', 'shared/cleaner.js', 'shared/settings.js', `${page}/${page}.js`]) {
    await vm.runInContext(await fs.readFile(path.join(ROOT, 'src', script), 'utf8'), context, { filename: script });
  }
  holdStorage = true;

  async function release(method) {
    // Drain a bounded number of microtasks. No clock timing controls this race.
    for (let turn = 0; !pending.length && turn < 50; turn++) await Promise.resolve();
    assert.equal(pending[0]?.method, method, `expected a pending storage ${method}`);
    pending.shift().release();
  }
  return {
    document,
    stored: () => stored.settings,
    element: (selector) => selector.startsWith('#')
      ? document.getElementById(selector.slice(1))
      : elements.find((element) => element.dataset.category === selector || element.dataset.setting === selector),
    change(element, checked) {
      assert.ok(element, 'change requires a rendered control');
      element.checked = checked;
      const event = new Event('change', { bubbles: true });
      Object.defineProperty(event, 'target', { value: element });
      for (let target = element; target; target = target.parent) target.dispatchEvent(event);
    },
    async finishSave() {
      await release('get');
      await release('set');
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    },
  };
}

test('rapid category changes keep the selected values after an earlier save re-renders options', async () => {
  const ui = await loadUI('options');
  assert.equal(ui.element('strict').checked, false);
  ui.change(ui.element('strict'), true);
  ui.change(ui.element('affiliate'), false);
  await ui.finishSave();
  assert.equal(ui.element('affiliate').checked, true, 'first save re-renders the pending control');
  await ui.finishSave();
  assert.equal(ui.stored().categories.strict, true);
  assert.equal(ui.stored().categories.affiliate, false);
  assert.equal(ui.element('affiliate').checked, false);
});

test('the options master change keeps its selected value after another save re-renders it', async () => {
  const ui = await loadUI('options');
  ui.change(ui.element('strict'), true);
  ui.change(ui.element('#enabled'), false);
  await ui.finishSave();
  assert.equal(ui.element('#enabled').checked, true, 'first save re-renders the pending control');
  await ui.finishSave();
  assert.equal(ui.stored().enabled, false);
  assert.equal(ui.stored().categories.strict, true);
});

for (const setting of ['unwrapRedirects', 'removePing', 'cleanOnCopy', 'linkGuard', 'showBadge']) {
  test(`the ${setting} switch keeps its selected value after an earlier save re-renders it`, async () => {
    const ui = await loadUI('options');
    ui.change(ui.element('strict'), true);
    ui.change(ui.element(setting), false);
    await ui.finishSave();
    assert.equal(ui.element(setting).checked, true, `${setting}: first save re-renders the pending control`);
    await ui.finishSave();
    assert.equal(ui.stored()[setting], false, setting);
    assert.equal(ui.stored().categories.strict, true, setting);
  });
}

test('the popup master change keeps its selected value after a site save re-renders it', async () => {
  const ui = await loadUI('popup');
  ui.change(ui.element('#siteSwitch'), false);
  ui.change(ui.element('#masterSwitch'), false);
  await ui.finishSave();
  assert.equal(ui.element('#masterSwitch').checked, true, 'first save re-renders the pending control');
  await ui.finishSave();
  assert.equal(ui.stored().enabled, false);
  assert.deepEqual(ui.stored().pausedSites, ['example.com']);
  assert.equal(ui.element('#masterSwitch').checked, false);
});
