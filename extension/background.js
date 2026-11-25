importScripts('siteConfig.js');

const SCRIPT_ID_PREFIX = 'colorful-pwa-theme-';
const CONTENT_FILES = ['siteConfig.js', 'contentScript.js'];
const CONFIG_MESSAGE_TYPE = 'colorfulPwaConfigChanged';
const FOCUS_MESSAGE_TYPE = 'colorfulPwaWindowFocusChanged';

const {
  normalizeHostname,
  isIPv4,
  getCandidateKeys,
  getEnabledRegistrationHosts,
  resolveConfig,
  normalizeConfig
} = globalThis.ColorfulSiteConfig;
let operationQueue = Promise.resolve();
let storedConfigCache = null;
let configCacheLoad = null;
let pendingChanges = {};
let synchronizationScheduled = false;

function getRegistration(hostname) {
  const normalized = normalizeHostname(hostname);
  const idHost = normalized.replaceAll('.', '_');
  const isLocalOrIp = normalized === 'localhost' || isIPv4(normalized);
  const patternHost = isLocalOrIp ? normalized : `*.${normalized}`;

  return {
    id: `${SCRIPT_ID_PREFIX}${idHost}`,
    matches: [`http://${patternHost}/*`, `https://${patternHost}/*`],
    js: CONTENT_FILES,
    runAt: 'document_idle',
    persistAcrossSessions: true
  };
}

function sameRegistration(current, desired) {
  return current.runAt === desired.runAt &&
    current.persistAcrossSessions === desired.persistAcrossSessions &&
    JSON.stringify(current.js ?? []) === JSON.stringify(desired.js) &&
    JSON.stringify([...(current.matches ?? [])].sort()) === JSON.stringify([...desired.matches].sort());
}

async function reconcileRegistrations(stored) {
  const desired = getEnabledRegistrationHosts(stored).map(getRegistration);
  const desiredById = new Map(desired.map((registration) => [registration.id, registration]));
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const owned = registered.filter((registration) => registration.id.startsWith(SCRIPT_ID_PREFIX));
  const removeIds = owned
    .filter((registration) => {
      const replacement = desiredById.get(registration.id);
      return !replacement || !sameRegistration(registration, replacement);
    })
    .map((registration) => registration.id);

  if (removeIds.length) await chrome.scripting.unregisterContentScripts({ ids: removeIds });

  const retainedIds = new Set(owned
    .filter((registration) => {
      const replacement = desiredById.get(registration.id);
      return replacement && sameRegistration(registration, replacement);
    })
    .map((registration) => registration.id));
  const additions = desired.filter((registration) => !retainedIds.has(registration.id));
  if (additions.length) await chrome.scripting.registerContentScripts(additions);
}

function isSupportedPwaWindow() {
  return ['standalone', 'minimal-ui', 'window-controls-overlay'].some((mode) =>
    window.matchMedia(`(display-mode: ${mode})`).matches
  );
}

async function probePwaWindow(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: isSupportedPwaWindow
    });
    return result?.result === true;
  } catch (_error) {
    return false;
  }
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const failed = Boolean(chrome.runtime.lastError);
      if (response?.handled === true) resolve('handled');
      else resolve(failed ? 'missing' : 'unhandled');
    });
  });
}

async function isWindowFocused(windowId) {
  if (typeof windowId !== 'number' || windowId === chrome.windows.WINDOW_ID_NONE) {
    return false;
  }
  try {
    const win = await chrome.windows.get(windowId);
    return Boolean(win?.focused);
  } catch (_error) {
    return false;
  }
}

function sendResolvedConfig(tabId, hostname, config, windowFocused) {
  return sendTabMessage(tabId, {
    type: CONFIG_MESSAGE_TYPE,
    hostname,
    config,
    windowFocused
  });
}

async function updateTab(tab, hostname, config) {
  if (typeof tab.id !== 'number') return;

  const normalizedHost = normalizeHostname(hostname);
  const windowFocused = await isWindowFocused(tab.windowId);
  const messageStatus = await sendResolvedConfig(tab.id, normalizedHost, config, windowFocused);
  if (messageStatus === 'handled' || messageStatus === 'unhandled') return;

  if (config?.enabled !== true || !(await probePwaWindow(tab.id))) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_FILES
    });
  } catch (_error) {
    return;
  }
}

async function notifyAffectedTabs(stored, changedKeys) {
  if (changedKeys.size === 0) return;
  const normalizedChangedKeys = new Set(
    [...changedKeys].map((key) => normalizeHostname(key)).filter(Boolean)
  );
  if (normalizedChangedKeys.size === 0) return;
  const tabs = await chrome.tabs.query({});
  const updates = [];

  for (const tab of tabs) {
    if (typeof tab.url !== 'string' || typeof tab.id !== 'number') continue;
    let url;
    try {
      url = new URL(tab.url);
    } catch (_error) {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;

    const normalizedHost = normalizeHostname(url.hostname);
    const candidateKeys = getCandidateKeys(normalizedHost);
    if (!candidateKeys.some((key) => normalizedChangedKeys.has(key))) continue;
    const config = resolveConfig(normalizedHost, stored);
    updates.push(updateTab(tab, normalizedHost, config));
  }

  await Promise.all(updates);
}

async function broadcastWindowFocus(windowId) {
  try {
    const stored = await ensureStoredConfigCache();
    let focusedWindowId = chrome.windows.WINDOW_ID_NONE;
    if (typeof windowId === 'number' && windowId !== chrome.windows.WINDOW_ID_NONE) {
      const verified = await isWindowFocused(windowId);
      if (verified) focusedWindowId = windowId;
    }

    const tabs = await chrome.tabs.query({ active: true });
    const deliveries = [];
    for (const tab of tabs) {
      if (typeof tab.url !== 'string' || typeof tab.id !== 'number') continue;
      let url;
      try {
        url = new URL(tab.url);
      } catch (_error) {
        continue;
      }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const normalizedHost = normalizeHostname(url.hostname);
      const rawConfig = resolveConfig(normalizedHost, stored);
      if (!rawConfig) continue;
      const config = normalizeConfig(rawConfig);
      if (!config.enabled || !config.windowStateEnabled) continue;

      deliveries.push(sendTabMessage(tab.id, {
        type: FOCUS_MESSAGE_TYPE,
        hostname: normalizedHost,
        focused: tab.windowId === focusedWindowId
      }));
    }
    await Promise.all(deliveries);
  } catch (_error) {
    return;
  }
}

async function ensureStoredConfigCache() {
  if (storedConfigCache) return storedConfigCache;
  if (!configCacheLoad) {
    configCacheLoad = chrome.storage.sync.get(null)
      .then((stored) => {
        storedConfigCache = stored;
        return stored;
      })
      .finally(() => {
        configCacheLoad = null;
      });
  }
  return configCacheLoad;
}

async function synchronize(changes = {}) {
  await ensureStoredConfigCache();
  for (const [key, change] of Object.entries(changes)) {
    if (Object.prototype.hasOwnProperty.call(change, 'newValue')) {
      storedConfigCache[key] = change.newValue;
    } else {
      delete storedConfigCache[key];
    }
  }

  await reconcileRegistrations(storedConfigCache);
  const changedKeys = new Set(Object.keys(changes));
  await notifyAffectedTabs(storedConfigCache, changedKeys);
}

function enqueueSynchronization(changes = {}) {
  Object.assign(pendingChanges, changes);
  if (synchronizationScheduled) return operationQueue;

  synchronizationScheduled = true;
  operationQueue = operationQueue.catch(() => {}).then(async () => {
    const changesToApply = pendingChanges;
    pendingChanges = {};
    synchronizationScheduled = false;
    await synchronize(changesToApply);
  }).catch((error) => {
    console.error('Tintpane settings synchronization failed.', error);
  });
  return operationQueue;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  void enqueueSynchronization(changes);
});

if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    void broadcastWindowFocus(windowId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'colorfulPwaGetResolvedConfig') return;

  let url;
  try {
    url = new URL(sender.url ?? sender.tab?.url ?? '');
  } catch (_error) {
    sendResponse({ hostname: '', config: null, windowFocused: false });
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    sendResponse({ hostname: '', config: null, windowFocused: false });
    return;
  }

  const normalizedHost = normalizeHostname(url.hostname);
  void operationQueue
    .catch(() => {})
    .then(() => ensureStoredConfigCache())
    .then(async (stored) => {
      const windowFocused = await isWindowFocused(sender.tab?.windowId);
      sendResponse({
        hostname: normalizedHost,
        config: resolveConfig(normalizedHost, stored),
        windowFocused
      });
    })
    .catch(() => sendResponse({ hostname: normalizedHost, config: null, windowFocused: false }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  // Do not probe or reinject into existing tabs during extension installation.
  void enqueueSynchronization();
});

chrome.runtime.onStartup.addListener(() => {
  // Persisted registrations are reconciled once at browser startup.
  void enqueueSynchronization();
});

void enqueueSynchronization();
