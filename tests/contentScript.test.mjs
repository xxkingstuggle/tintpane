import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(currentDir, '../extension');
const siteConfigSource = fs.readFileSync(path.join(extensionDir, 'siteConfig.js'), 'utf8');
const contentScriptSource = fs.readFileSync(path.join(extensionDir, 'contentScript.js'), 'utf8');

async function flushMicrotasks(rounds = 8) {
  for (let step = 0; step < rounds; step += 1) {
    await Promise.resolve();
  }
}

function createDomHarness({
  hostname = 'app.example.com',
  displayMode = 'standalone',
  darkScheme = false,
  hasFocus = true,
  visibilityState = 'visible',
  mountHead = true,
  initialMetas = [],
  resolvedResponse = null
} = {}) {
  const observers = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const mediaListeners = new Map();
  const runtimeListeners = [];
  const sentMessages = [];
  const pendingTimers = new Map();
  let nextTimerId = 1;
  let nowMs = 1_000_000;
  let runtimeId = 'test-extension-id';
  let currentDark = darkScheme;
  let currentHasFocus = hasFocus;
  let currentVisibility = visibilityState;

  function isDescendant(root, candidate) {
    let node = candidate;
    while (node) {
      if (node === root) return true;
      node = node.parentNode;
    }
    return false;
  }

  function notifyObservers(record) {
    for (const observer of observers) {
      if (!observer.active || !observer.target) continue;
      const matchesRoot = record.target === observer.target ||
        (observer.options.subtree && isDescendant(observer.target, record.target));
      if (!matchesRoot) continue;

      if (record.type === 'attributes') {
        if (!observer.options.attributes) continue;
        if (observer.options.attributeFilter && !observer.options.attributeFilter.includes(record.attributeName)) {
          continue;
        }
      } else if (record.type === 'childList') {
        if (!observer.options.childList) continue;
      }

      observer.records.push(record);
      if (!observer.scheduled) {
        observer.scheduled = true;
        queueMicrotask(() => {
          observer.scheduled = false;
          if (!observer.active) return;
          const batch = observer.records.splice(0);
          if (batch.length) observer.callback(batch, observer);
        });
      }
    }
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
    }

    get isConnected() {
      let cursor = this;
      while (cursor) {
        if (cursor === documentElement) return true;
        cursor = cursor.parentNode;
      }
      return false;
    }

    setAttribute(name, value) {
      const lowerName = String(name).toLowerCase();
      this.attributes.set(lowerName, String(value));
      notifyObservers({ type: 'attributes', target: this, attributeName: lowerName });
    }

    removeAttribute(name) {
      const lowerName = String(name).toLowerCase();
      this.attributes.delete(lowerName);
      notifyObservers({ type: 'attributes', target: this, attributeName: lowerName });
    }

    getAttribute(name) {
      const lowerName = String(name).toLowerCase();
      return this.attributes.has(lowerName) ? this.attributes.get(lowerName) : null;
    }

    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase());
    }

    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      notifyObservers({
        type: 'childList',
        target: this,
        addedNodes: [child],
        removedNodes: []
      });
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index === -1) return child;
      this.children.splice(index, 1);
      child.parentNode = null;
      notifyObservers({
        type: 'childList',
        target: this,
        addedNodes: [],
        removedNodes: [child]
      });
      return child;
    }

    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
  }

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = {};
      this.active = false;
      this.scheduled = false;
      this.records = [];
      observers.push(this);
    }

    observe(target, options = {}) {
      this.target = target;
      this.options = options;
      this.active = true;
    }

    disconnect() {
      this.active = false;
      this.records = [];
      this.target = null;
    }

    takeRecords() {
      return this.records.splice(0);
    }
  }

  const documentElement = new MockElement('html');
  let headElement = null;
  if (mountHead) {
    headElement = new MockElement('head');
    documentElement.appendChild(headElement);
    for (const metaSpec of initialMetas) {
      const meta = new MockElement('meta');
      for (const [attrName, attrValue] of Object.entries(metaSpec)) {
        meta.attributes.set(attrName.toLowerCase(), String(attrValue));
      }
      meta.parentNode = headElement;
      headElement.children.push(meta);
    }
  }

  function collectElements(root, output = []) {
    for (const child of root.children) {
      output.push(child);
      collectElements(child, output);
    }
    return output;
  }

  const documentObj = {
    documentElement,
    get head() {
      return headElement;
    },
    get visibilityState() {
      return currentVisibility;
    },
    hasFocus() {
      return currentHasFocus;
    },
    createElement(tagName) {
      return new MockElement(tagName);
    },
    querySelectorAll(selector) {
      const all = collectElements(documentElement);
      if (selector === 'meta[name="theme-color" i]') {
        return all.filter((node) =>
          node.tagName === 'META' &&
          node.getAttribute('name')?.toLowerCase() === 'theme-color'
        );
      }
      if (selector === 'meta[name]') {
        return all.filter((node) => node.tagName === 'META' && node.hasAttribute('name'));
      }
      return [];
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    }
  };

  function matchMedia(query) {
    if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
    return {
      media: query,
      get matches() {
        if (query === `(display-mode: ${displayMode})`) return true;
        if (query.startsWith('(display-mode:')) return false;
        if (query === '(prefers-color-scheme: dark)') return currentDark;
        if (query === '(prefers-color-scheme: light)') return !currentDark;
        return false;
      },
      addEventListener(type, listener) {
        if (type === 'change') mediaListeners.get(query).add(listener);
      },
      removeEventListener(type, listener) {
        if (type === 'change') mediaListeners.get(query).delete(listener);
      }
    };
  }

  const chromeObj = {
    runtime: {
      get id() {
        return runtimeId;
      },
      sendMessage(message) {
        sentMessages.push(message);
        if (!runtimeId) return Promise.reject(new Error('Extension context invalidated'));
        return Promise.resolve(resolvedResponse);
      },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        },
        removeListener(listener) {
          const index = runtimeListeners.indexOf(listener);
          if (index !== -1) runtimeListeners.splice(index, 1);
        }
      }
    }
  };

  const FakeDate = {
    now() {
      return nowMs;
    }
  };

  const sandbox = {
    document: documentObj,
    chrome: chromeObj,
    MutationObserver: MockMutationObserver,
    queueMicrotask,
    Date: FakeDate,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      pendingTimers.set(id, { callback, runAt: nowMs + Number(delay ?? 0) });
      return id;
    },
    clearTimeout(id) {
      pendingTimers.delete(id);
    },
    location: { hostname },
    matchMedia,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener);
    }
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);

  function inject() {
    vm.runInContext(siteConfigSource, context, { filename: 'siteConfig.js' });
    vm.runInContext(contentScriptSource, context, { filename: 'contentScript.js' });
  }

  function dispatchRuntimeMessage(message) {
    let responsePayload;
    for (const listener of [...runtimeListeners]) {
      listener(message, {}, (response) => {
        responsePayload = response;
      });
    }
    return responsePayload;
  }

  function dispatchWindowEvent(type) {
    for (const listener of [...(windowListeners.get(type) ?? [])]) listener();
  }

  function dispatchDocumentEvent(type) {
    for (const listener of [...(documentListeners.get(type) ?? [])]) listener();
  }

  return {
    context,
    documentObj,
    observers,
    windowListeners,
    documentListeners,
    runtimeListeners,
    sentMessages,
    pendingTimers,
    inject,
    dispatchRuntimeMessage,
    dispatchWindowEvent,
    dispatchDocumentEvent,
    setDarkScheme(nextDark) {
      currentDark = nextDark;
      for (const listener of [...(mediaListeners.get('(prefers-color-scheme: dark)') ?? [])]) {
        listener({ matches: currentDark });
      }
    },
    setFocusState({ focused, visibility }) {
      if (typeof focused === 'boolean') currentHasFocus = focused;
      if (typeof visibility === 'string') currentVisibility = visibility;
    },
    mountLateHead() {
      if (!headElement) {
        headElement = new MockElement('head');
        documentElement.appendChild(headElement);
      }
      return headElement;
    },
    invalidateRuntime() {
      runtimeId = undefined;
    },
    advanceClock(ms) {
      nowMs += ms;
      for (const [id, timer] of [...pendingTimers.entries()]) {
        if (timer.runAt <= nowMs) {
          pendingTimers.delete(id);
          timer.callback();
        }
      }
    },
    getThemeColorMetas() {
      return documentObj.querySelectorAll('meta[name="theme-color" i]');
    },
    activeObserverCount() {
      return observers.filter((observer) => observer.active).length;
    }
  };
}

test('ordinary browser tabs exit immediately without messaging background or touching DOM', async () => {
  const harness = createDomHarness({
    displayMode: 'browser',
    initialMetas: [{ name: 'theme-color', content: '#111111' }],
    resolvedResponse: {
      hostname: 'app.example.com',
      config: { enabled: true, themeMode: 'fixed', activeColor: '#223344' },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.runtimeListeners.length, 0);
  assert.equal(harness.getThemeColorMetas()[0].getAttribute('content'), '#111111');
});

test('handles case-insensitive and multi-media theme-color tags and restores media attributes intact', async () => {
  const harness = createDomHarness({
    darkScheme: true,
    initialMetas: [
      { name: 'THEME-COLOR', media: '(prefers-color-scheme: light)', content: '#FAFAFA' },
      { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#101010' }
    ],
    resolvedResponse: {
      hostname: 'app.example.com',
      config: {
        enabled: true,
        themeMode: 'system',
        lightActiveColor: '#F1F5FB',
        darkActiveColor: '#0F172A'
      },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  const metas = harness.getThemeColorMetas();
  assert.equal(metas.length, 2);
  assert.equal(metas[0].getAttribute('content'), '#0F172A');
  assert.equal(metas[1].getAttribute('content'), '#0F172A');
  assert.equal(metas[0].getAttribute('media'), '(prefers-color-scheme: light)');
  assert.equal(metas[1].getAttribute('media'), '(prefers-color-scheme: dark)');

  harness.dispatchRuntimeMessage({
    type: 'colorfulPwaConfigChanged',
    hostname: 'app.example.com',
    config: { enabled: false },
    windowFocused: true
  });
  await flushMicrotasks();

  assert.equal(metas[0].getAttribute('content'), '#FAFAFA');
  assert.equal(metas[1].getAttribute('content'), '#101010');
  assert.equal(metas[0].getAttribute('media'), '(prefers-color-scheme: light)');
  assert.equal(harness.activeObserverCount(), 0);
});

test('appends unconditional fallback meta when only non-matching media tag exists and removes it on disable', async () => {
  const harness = createDomHarness({
    darkScheme: true,
    initialMetas: [
      { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#FFFFFF' }
    ],
    resolvedResponse: {
      hostname: 'app.example.com',
      config: {
        enabled: true,
        themeMode: 'system',
        lightActiveColor: '#FFFFFF',
        darkActiveColor: '#12211A'
      },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  let metas = harness.getThemeColorMetas();
  assert.equal(metas.length, 2);
  assert.equal(metas[1].hasAttribute('media'), false);
  assert.equal(metas[1].getAttribute('content'), '#12211A');

  harness.dispatchRuntimeMessage({
    type: 'colorfulPwaConfigChanged',
    hostname: 'app.example.com',
    config: { enabled: false },
    windowFocused: true
  });
  await flushMicrotasks();

  metas = harness.getThemeColorMetas();
  assert.equal(metas.length, 1);
  assert.equal(metas[0].getAttribute('content'), '#FFFFFF');
  assert.equal(metas[0].getAttribute('media'), '(prefers-color-scheme: light)');
});

test('re-applies color when SPA mutates theme-color and trips circuit breaker on hostile mutation storm', async () => {
  const harness = createDomHarness({
    initialMetas: [{ name: 'theme-color', content: '#FFFFFF' }],
    resolvedResponse: {
      hostname: 'app.example.com',
      config: { enabled: true, themeMode: 'fixed', activeColor: '#0F172A' },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  const meta = harness.getThemeColorMetas()[0];
  assert.equal(meta.getAttribute('content'), '#0F172A');

  meta.setAttribute('content', '#FF0000');
  await flushMicrotasks();
  assert.equal(meta.getAttribute('content'), '#0F172A');

  for (let count = 0; count < 22; count += 1) {
    meta.setAttribute('content', `#AA00${String(count).padStart(2, '0')}`);
    await flushMicrotasks();
  }
  assert.ok(harness.pendingTimers.size >= 1, 'Expected backoff timer after exceeding mutation rate limit');

  harness.advanceClock(300);
  await flushMicrotasks();
  assert.equal(meta.getAttribute('content'), '#0F172A');
});

test('waits for late-mounted document.head before applying theme color', async () => {
  const harness = createDomHarness({
    mountHead: false,
    resolvedResponse: {
      hostname: 'app.example.com',
      config: { enabled: true, themeMode: 'fixed', activeColor: '#231E1A' },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  assert.equal(harness.getThemeColorMetas().length, 0);
  assert.equal(harness.activeObserverCount(), 1);

  harness.mountLateHead();
  await flushMicrotasks();

  const metas = harness.getThemeColorMetas();
  assert.equal(metas.length, 1);
  assert.equal(metas[0].getAttribute('content'), '#231E1A');
});

test('repeated re-injection refreshes existing controller without duplicating observers or listeners', async () => {
  const harness = createDomHarness({
    resolvedResponse: {
      hostname: 'app.example.com',
      config: {
        enabled: true,
        windowStateEnabled: true,
        themeMode: 'fixed',
        activeColor: '#1E1F22',
        inactiveColor: '#2B2D31'
      },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  harness.inject();
  await flushMicrotasks();

  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.runtimeListeners.length, 1);
  assert.equal(harness.activeObserverCount(), 1);
  assert.equal(harness.windowListeners.get('focus')?.size ?? 0, 1);
  assert.equal(harness.windowListeners.get('blur')?.size ?? 0, 1);
});

test('dual-source focus switches between active and inactive colors and ignores stale host messages', async () => {
  const harness = createDomHarness({
    resolvedResponse: {
      hostname: 'app.example.com',
      config: {
        enabled: true,
        windowStateEnabled: true,
        themeMode: 'fixed',
        activeColor: '#1E1F22',
        inactiveColor: '#4A4D55'
      },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  const meta = harness.getThemeColorMetas()[0];
  assert.equal(meta.getAttribute('content'), '#1E1F22');

  const staleReply = harness.dispatchRuntimeMessage({
    type: 'colorfulPwaWindowFocusChanged',
    hostname: 'other.example.com',
    focused: false
  });
  assert.equal(staleReply.stale, true);
  await flushMicrotasks();
  assert.equal(meta.getAttribute('content'), '#1E1F22');

  harness.dispatchRuntimeMessage({
    type: 'colorfulPwaWindowFocusChanged',
    hostname: 'app.example.com',
    focused: false
  });
  await flushMicrotasks();
  assert.equal(meta.getAttribute('content'), '#4A4D55');

  harness.dispatchWindowEvent('focus');
  await flushMicrotasks();
  assert.equal(meta.getAttribute('content'), '#1E1F22');

  harness.setFocusState({ visibility: 'hidden' });
  harness.dispatchDocumentEvent('visibilitychange');
  await flushMicrotasks();
  assert.equal(meta.getAttribute('content'), '#4A4D55');
});

test('restore skips meta overwritten by page and disposes cleanly when extension context invalidates', async () => {
  const harness = createDomHarness({
    initialMetas: [{ name: 'theme-color', content: '#111111' }],
    resolvedResponse: {
      hostname: 'app.example.com',
      config: { enabled: true, themeMode: 'fixed', activeColor: '#222222' },
      windowFocused: true
    }
  });
  harness.inject();
  await flushMicrotasks();

  const meta = harness.getThemeColorMetas()[0];
  assert.equal(meta.getAttribute('content'), '#222222');

  harness.invalidateRuntime();
  meta.setAttribute('content', '#999999');
  await flushMicrotasks();

  assert.equal(meta.getAttribute('content'), '#999999');
  assert.equal(harness.activeObserverCount(), 0);
  assert.equal(harness.context.__tintpaneController__, undefined);
});
