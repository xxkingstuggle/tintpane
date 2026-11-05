importScripts('siteConfig.js');

const SCRIPT_ID_PREFIX = 'colorful-pwa-theme-';
const CONTENT_FILES = ['contentScript.js'];
const CONFIG_MESSAGE_TYPE = 'colorfulPwaConfigChanged';

const { getCandidateKeys, getEnabledRegistrationHosts, resolveConfig } = globalThis.ColorfulSiteConfig;
let operationQueue = Promise.resolve();
let storedConfigCache = null;
let configCacheLoad = null;
let pendingChanges = {};
let synchronizationScheduled = false;

function getRegistration(hostname) {
  const idHost = hostname.replaceAll('.', '_');
  const isLocalOrIp = hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const patternHost = isLocalOrIp ? hostname : `*.${hostname}`;

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

function sendResolvedConfig(tabId, hostname, config) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, {
      type: CONFIG_MESSAGE_TYPE,
      hostname,
      config
    }, (response) => {
      const failed = Boolean(chrome.runtime.lastError);
      if (response?.handled === true) resolve('handled');
      else resolve(failed ? 'missing' : 'unhandled');
    });
  });
}

async function updateTab(tab, hostname, config) {
  if (typeof tab.id !== 'number') return;

  const messageStatus = await sendResolvedConfig(tab.id, hostname, config);
  if (messageStatus === 'handled' || messageStatus === 'unhandled') return;

  // No listener means this PWA was opened before the site was enabled, or a
  // disabled controller has disposed itself. An unhandled receiver may be an
  // older controller; avoid stacking a new one on that document.
  if (config?.enabled !== true || !(await probePwaWindow(tab.id))) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_FILES
    });
  } catch (_error) {
    // Restricted pages and tabs that navigated during the update are skipped.
  }
}

async function notifyAffectedTabs(stored, changedKeys) {
  if (changedKeys.size === 0) return;
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

    const candidateKeys = getCandidateKeys(url.hostname);
    if (!candidateKeys.some((key) => changedKeys.has(key))) continue;
    const config = resolveConfig(url.hostname, stored);
    updates.push(updateTab(tab, url.hostname, config));
  }

  await Promise.all(updates);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'colorfulPwaGetResolvedConfig') return;

  let url;
  try {
    url = new URL(sender.url ?? sender.tab?.url ?? '');
  } catch (_error) {
    sendResponse({ hostname: '', config: null });
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    sendResponse({ hostname: '', config: null });
    return;
  }

  void operationQueue
    .catch(() => {})
    .then(() => ensureStoredConfigCache())
    .then((stored) => sendResponse({
      hostname: url.hostname,
      config: resolveConfig(url.hostname, stored)
    }))
    .catch(() => sendResponse({ hostname: url.hostname, config: null }));
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
