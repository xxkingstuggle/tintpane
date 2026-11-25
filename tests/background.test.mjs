import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(currentDir, '../extension');
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');

async function drainAsyncQueue() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createBackgroundHarness({
  initialStorage = {},
  initialRegisteredScripts = [],
  tabs = [],
  windows = [{ id: 1, focused: true }],
  pwaTabIds = new Set(),
  mountedTabIds = new Set()
} = {}) {
  const storage = { ...initialStorage };
  let registeredScripts = [...initialRegisteredScripts];
  const storageListeners = [];
  const focusListeners = [];
  const messageListeners = [];
  const sentTabMessages = [];
  const executedScripts = [];
  const windowMap = new Map(windows.map((win) => [win.id, { ...win }]));

  const chromeObj = {
    storage: {
      sync: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...storage };
          const result = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(storage, key)) {
              result[key] = storage[key];
            }
          }
          return result;
        }
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      }
    },
    scripting: {
      async getRegisteredContentScripts() {
        return registeredScripts.map((entry) => ({
          ...entry,
          js: [...entry.js],
          matches: [...entry.matches]
        }));
      },
      async registerContentScripts(additions) {
        for (const item of additions) {
          registeredScripts.push({
            ...item,
            js: [...item.js],
            matches: [...item.matches]
          });
        }
      },
      async unregisterContentScripts({ ids }) {
        const idSet = new Set(ids);
        registeredScripts = registeredScripts.filter((entry) => !idSet.has(entry.id));
      },
      async executeScript(details) {
        executedScripts.push({
          ...details,
          files: Array.isArray(details.files) ? [...details.files] : undefined
        });
        if (typeof details.func === 'function') {
          return [{ result: pwaTabIds.has(details.target.tabId) }];
        }
        if (Array.isArray(details.files)) {
          mountedTabIds.add(details.target.tabId);
        }
        return [{ result: undefined }];
      }
    },
    tabs: {
      async query(filter = {}) {
        return tabs.filter((tab) => {
          if (filter.active === true && !tab.active) return false;
          return true;
        });
      },
      sendMessage(tabId, payload, callback) {
        sentTabMessages.push({ tabId, payload });
        if (mountedTabIds.has(tabId)) {
          chromeObj.runtime.lastError = undefined;
          callback({ handled: true });
        } else {
          chromeObj.runtime.lastError = { message: 'Receiving end does not exist.' };
          callback(undefined);
          chromeObj.runtime.lastError = undefined;
        }
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async get(windowId) {
        const found = windowMap.get(windowId);
        if (!found) throw new Error('Window not found');
        return { ...found };
      },
      onFocusChanged: {
        addListener(listener) {
          focusListeners.push(listener);
        }
      }
    },
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        }
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    }
  };

  const sandbox = {
    chrome: chromeObj,
    URL,
    console,
    importScripts(...fileNames) {
      for (const fileName of fileNames) {
        const filePath = path.join(extensionDir, fileName);
        const code = fs.readFileSync(filePath, 'utf8');
        vm.runInContext(code, context, { filename: fileName });
      }
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  async function emitStorageChange(changes, areaName = 'sync') {
    for (const [key, change] of Object.entries(changes)) {
      if (Object.prototype.hasOwnProperty.call(change, 'newValue')) {
        storage[key] = change.newValue;
      } else {
        delete storage[key];
      }
    }
    for (const listener of storageListeners) {
      listener(changes, areaName);
    }
    await drainAsyncQueue();
  }

  async function emitWindowFocus(windowId) {
    for (const [id, win] of windowMap.entries()) {
      win.focused = id === windowId;
    }
    for (const listener of focusListeners) {
      listener(windowId);
    }
    await drainAsyncQueue();
  }

  function sendRuntimeMessage(message, sender) {
    return new Promise((resolve) => {
      for (const listener of messageListeners) {
        listener(message, sender, resolve);
      }
    });
  }

  return {
    getRegisteredScripts: () => registeredScripts,
    sentTabMessages,
    executedScripts,
    windowMap,
    emitStorageChange,
    emitWindowFocus,
    sendRuntimeMessage
  };
}

test('reconcileRegistrations registers CONTENT_FILES for domains/localhost/IPv4 and preserves third-party scripts', async () => {
  const harness = createBackgroundHarness({
    initialStorage: {
      'example.com': { enabled: true },
      'docs.example.com': { enabled: true },
      localhost: { enabled: true },
      '127.0.0.1': { enabled: true }
    },
    initialRegisteredScripts: [
      { id: 'third-party-script', matches: ['https://other.test/*'], js: ['other.js'], runAt: 'document_idle', persistAcrossSessions: true }
    ]
  });
  await drainAsyncQueue();

  const registered = harness.getRegisteredScripts();
  assert.equal(registered.length, 4);
  const exampleReg = registered.find((item) => item.id === 'colorful-pwa-theme-example_com');
  assert.deepEqual(exampleReg.js, ['siteConfig.js', 'contentScript.js']);
  assert.deepEqual(exampleReg.matches, ['http://*.example.com/*', 'https://*.example.com/*']);

  const localhostReg = registered.find((item) => item.id === 'colorful-pwa-theme-localhost');
  assert.deepEqual(localhostReg.matches, ['http://localhost/*', 'https://localhost/*']);

  const ipReg = registered.find((item) => item.id === 'colorful-pwa-theme-127_0_0_1');
  assert.deepEqual(ipReg.matches, ['http://127.0.0.1/*', 'https://127.0.0.1/*']);
  assert.ok(registered.some((item) => item.id === 'third-party-script'));
});

test('child disable overrides parent enable and removing override dynamically injects CONTENT_FILES into PWA tabs only', async () => {
  const harness = createBackgroundHarness({
    initialStorage: {
      'example.com': { enabled: true, themeMode: 'fixed', activeColor: '#112233' },
      'app.example.com': { enabled: false }
    },
    tabs: [
      { id: 10, windowId: 1, active: true, url: 'https://app.example.com/home' },
      { id: 11, windowId: 1, active: false, url: 'https://app.example.com/browser-tab' }
    ],
    pwaTabIds: new Set([10]),
    mountedTabIds: new Set()
  });
  await drainAsyncQueue();

  const initialResolved = await harness.sendRuntimeMessage(
    { type: 'colorfulPwaGetResolvedConfig' },
    { url: 'https://app.example.com/home', tab: { id: 10, windowId: 1 } }
  );
  assert.equal(initialResolved.config.enabled, false);
  assert.equal(initialResolved.windowFocused, true);

  await harness.emitStorageChange({
    'app.example.com': { oldValue: { enabled: false } }
  });

  const fileInjections = harness.executedScripts.filter((call) => Array.isArray(call.files));
  assert.equal(fileInjections.length, 1);
  assert.equal(fileInjections[0].target.tabId, 10);
  assert.deepEqual(fileInjections[0].files, ['siteConfig.js', 'contentScript.js']);
});

test('windows.onFocusChanged verifies focus and broadcasts active/inactive transitions including WINDOW_ID_NONE', async () => {
  const harness = createBackgroundHarness({
    initialStorage: {
      'example.com': { enabled: true, windowStateEnabled: true },
      'static.org': { enabled: true, windowStateEnabled: false }
    },
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'https://app.example.com/' },
      { id: 2, windowId: 2, active: true, url: 'https://docs.example.com/' },
      { id: 3, windowId: 2, active: true, url: 'https://static.org/' }
    ],
    windows: [
      { id: 1, focused: true },
      { id: 2, focused: false }
    ],
    mountedTabIds: new Set([1, 2, 3])
  });
  await drainAsyncQueue();

  await harness.emitWindowFocus(2);
  const focusMessages = harness.sentTabMessages.filter((item) => item.payload.type === 'colorfulPwaWindowFocusChanged');
  assert.equal(focusMessages.length, 2);
  assert.equal(focusMessages.find((item) => item.tabId === 1).payload.focused, false);
  assert.equal(focusMessages.find((item) => item.tabId === 2).payload.focused, true);

  harness.sentTabMessages.length = 0;
  await harness.emitWindowFocus(-1);
  assert.equal(harness.sentTabMessages.length, 2);
  assert.equal(harness.sentTabMessages.every((item) => item.payload.focused === false), true);
});

test('bursts of storage.onChanged updates coalesce cleanly through the serialized queue', async () => {
  const harness = createBackgroundHarness({
    initialStorage: {},
    tabs: [{ id: 5, windowId: 1, active: true, url: 'https://example.com/' }],
    mountedTabIds: new Set([5])
  });
  await drainAsyncQueue();

  const firstBurst = harness.emitStorageChange({
    'example.com': { newValue: { enabled: true, themeMode: 'fixed', activeColor: '#111111' } }
  });
  const secondBurst = harness.emitStorageChange({
    'example.com': { newValue: { enabled: true, themeMode: 'fixed', activeColor: '#222222' } }
  });
  await Promise.all([firstBurst, secondBurst]);

  const resolved = await harness.sendRuntimeMessage(
    { type: 'colorfulPwaGetResolvedConfig' },
    { url: 'https://example.com/', tab: { id: 5, windowId: 1 } }
  );
  assert.equal(resolved.config.activeColor, '#222222');
  assert.equal(harness.getRegisteredScripts().length, 1);
});
