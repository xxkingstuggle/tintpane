(() => {
  const CONTROLLER_KEY = '__tintpaneController__';
  const LEGACY_CONTROLLER_KEY = '__colorfulPwaThemeController__';

  const legacyController = globalThis[LEGACY_CONTROLLER_KEY];
  if (legacyController && typeof legacyController.dispose === 'function') {
    legacyController.dispose();
  }

  const existingController = globalThis[CONTROLLER_KEY];
  if (existingController) {
    if (existingController.state !== 'disposed' && typeof existingController.refresh === 'function') {
      existingController.refresh();
      return;
    }
    if (typeof existingController.dispose === 'function') {
      existingController.dispose();
    }
  }

  const supportedDisplayModes = ['standalone', 'minimal-ui', 'window-controls-overlay'];
  const isPwaWindow = supportedDisplayModes.some((mode) =>
    window.matchMedia(`(display-mode: ${mode})`).matches
  );
  if (!isPwaWindow) return;

  const siteConfig = globalThis.ColorfulSiteConfig;
  const normalizeHostname = siteConfig?.normalizeHostname ?? ((value) => String(value ?? '').trim().toLowerCase().replace(/\.+$/, ''));
  const normalizeConfig = siteConfig?.normalizeConfig ?? ((data) => ({
    enabled: Boolean(data?.enabled),
    windowStateEnabled: Boolean(data?.windowStateEnabled),
    themeMode: data?.themeMode === 'fixed' ? 'fixed' : 'system',
    activeColor: data?.activeColor ?? data?.color ?? '#FFFFFF',
    inactiveColor: data?.inactiveColor ?? data?.color ?? '#D3D3D3',
    lightActiveColor: data?.lightActiveColor ?? '#FFFFFF',
    lightInactiveColor: data?.lightInactiveColor ?? '#D3D3D3',
    darkActiveColor: data?.darkActiveColor ?? '#202124',
    darkInactiveColor: data?.darkInactiveColor ?? '#303134'
  }));

  const hostname = normalizeHostname(window.location.hostname);
  if (!hostname) return;

  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const MAX_MUTATION_APPLIES_PER_WINDOW = 20;
  const MUTATION_WINDOW_MS = 1000;
  const MUTATION_BACKOFF_MS = 250;

  let currentConfig = null;
  let configGeneration = 0;
  let disposed = false;
  let updateQueued = false;
  let isApplyingMeta = false;
  let systemListenerAttached = false;
  let focusListenersAttached = false;
  let runtimeListenerAttached = false;
  let mutationObserver = null;
  let observedRoot = null;
  let backoffTimer = null;
  let mutationApplyTimestamps = [];
  let isWindowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  const ownedMeta = new Map();

  const controller = {
    state: 'loading',
    dispose,
    refresh: fetchResolvedConfig
  };
  globalThis[CONTROLLER_KEY] = controller;

  function isExtensionContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_error) {
      return false;
    }
  }

  function isEffectivelyFocused() {
    if (document.visibilityState === 'hidden') return false;
    return isWindowFocused;
  }

  function getEffectiveColor() {
    if (!currentConfig?.enabled) return null;

    const variant = currentConfig.windowStateEnabled && !isEffectivelyFocused() ? 'Inactive' : 'Active';
    if (currentConfig.themeMode === 'system') {
      const prefix = colorSchemeQuery.matches ? 'dark' : 'light';
      return currentConfig[`${prefix}${variant}Color`];
    }
    return currentConfig[`${variant.toLowerCase()}Color`];
  }

  function queryThemeColorMetas() {
    try {
      return [...document.querySelectorAll('meta[name="theme-color" i]')];
    } catch (_error) {
      return [...document.querySelectorAll('meta[name]')].filter(
        (element) => element.getAttribute('name')?.toLowerCase() === 'theme-color'
      );
    }
  }

  function metaMatchesCurrentMedia(meta) {
    const media = meta.getAttribute('media');
    if (!media || !media.trim()) return true;
    try {
      return Boolean(window.matchMedia(media).matches);
    } catch (_error) {
      return false;
    }
  }

  function setOwnedMetaContent(meta, color, extensionCreated = false) {
    const hadContent = meta.hasAttribute('content');
    const content = meta.getAttribute('content');
    const hadMedia = meta.hasAttribute('media');
    const media = meta.getAttribute('media');
    let ownership = ownedMeta.get(meta);

    if (ownership && content !== ownership.lastApplied) {
      ownership.originalHadContent = hadContent;
      ownership.originalContent = content;
      ownership.originalHadMedia = hadMedia;
      ownership.originalMedia = media;
      ownership.extensionCreated = false;
    }

    if (content === color) {
      if (ownership) ownership.lastApplied = color;
      return;
    }

    if (!ownership) {
      ownership = {
        originalHadContent: hadContent,
        originalContent: content,
        originalHadMedia: hadMedia,
        originalMedia: media,
        lastApplied: null,
        extensionCreated
      };
      ownedMeta.set(meta, ownership);
    }

    meta.setAttribute('content', color);
    ownership.lastApplied = color;
  }

  function applyColor() {
    if (disposed || !currentConfig?.enabled) return;
    if (!isExtensionContextValid()) {
      dispose();
      return;
    }
    if (!document.head) {
      syncMutationObserver();
      return;
    }

    const color = getEffectiveColor();
    if (!color) return;

    isApplyingMeta = true;
    try {
      for (const meta of ownedMeta.keys()) {
        if (!meta.isConnected) ownedMeta.delete(meta);
      }

      let metas = queryThemeColorMetas();
      const hasMatchingMeta = metas.some(metaMatchesCurrentMedia);
      if (!metas.length || !hasMatchingMeta) {
        const meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
        metas = [...metas, meta];
        ownedMeta.set(meta, {
          originalHadContent: false,
          originalContent: null,
          originalHadMedia: false,
          originalMedia: null,
          lastApplied: null,
          extensionCreated: true
        });
      }

      for (const meta of metas) {
        setOwnedMetaContent(meta, color, false);
      }
    } finally {
      if (mutationObserver) mutationObserver.takeRecords();
      isApplyingMeta = false;
    }
    syncMutationObserver();
  }

  function queueColorUpdate() {
    if (disposed || updateQueued) return;
    if (!isExtensionContextValid()) {
      dispose();
      return;
    }
    updateQueued = true;
    queueMicrotask(() => {
      updateQueued = false;
      applyColor();
    });
  }

  function handleHeadMutations(records) {
    if (disposed || isApplyingMeta || !currentConfig?.enabled) return;
    if (!isExtensionContextValid()) {
      dispose();
      return;
    }

    if (observedRoot !== document.head && document.head) {
      syncMutationObserver();
      queueColorUpdate();
      return;
    }

    const targetColor = getEffectiveColor();
    if (!targetColor) return;

    const relevant = records.some((record) => {
      if (record.type === 'attributes') {
        const target = record.target;
        if (target?.tagName?.toLowerCase() !== 'meta') return false;
        const name = target.getAttribute?.('name')?.toLowerCase();
        if (record.attributeName === 'name') {
          return name === 'theme-color' || ownedMeta.has(target);
        }
        if (name !== 'theme-color') return false;
        if (record.attributeName === 'media') return true;
        return target.getAttribute('content') !== targetColor;
      }
      if (record.type === 'childList') {
        const nodes = [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])];
        return nodes.some((node) =>
          node?.tagName?.toLowerCase() === 'meta' &&
          node.getAttribute?.('name')?.toLowerCase() === 'theme-color'
        );
      }
      return false;
    });

    if (!relevant) return;

    const now = Date.now();
    mutationApplyTimestamps = mutationApplyTimestamps.filter((stamp) => now - stamp < MUTATION_WINDOW_MS);
    if (mutationApplyTimestamps.length >= MAX_MUTATION_APPLIES_PER_WINDOW) {
      if (!backoffTimer) {
        backoffTimer = setTimeout(() => {
          backoffTimer = null;
          mutationApplyTimestamps = [];
          queueColorUpdate();
        }, MUTATION_BACKOFF_MS);
      }
      return;
    }
    mutationApplyTimestamps.push(now);
    queueColorUpdate();
  }

  function disconnectMutationObserver() {
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    mutationApplyTimestamps = [];
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    observedRoot = null;
  }

  function syncMutationObserver() {
    const shouldObserve = Boolean(!disposed && currentConfig?.enabled && typeof MutationObserver === 'function');
    if (!shouldObserve) {
      disconnectMutationObserver();
      return;
    }

    const nextRoot = document.head ?? document.documentElement;
    if (!nextRoot) return;
    if (mutationObserver && observedRoot === nextRoot) return;

    disconnectMutationObserver();
    mutationObserver = new MutationObserver(handleHeadMutations);
    observedRoot = nextRoot;
    if (nextRoot === document.head) {
      mutationObserver.observe(nextRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['content', 'name', 'media']
      });
    } else {
      mutationObserver.observe(nextRoot, {
        childList: true,
        subtree: false
      });
    }
  }

  function onWindowFocus() {
    isWindowFocused = true;
    queueColorUpdate();
  }

  function onWindowBlur() {
    isWindowFocused = false;
    queueColorUpdate();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      isWindowFocused = false;
    } else if (typeof document.hasFocus === 'function') {
      isWindowFocused = document.hasFocus();
    }
    queueColorUpdate();
  }

  function syncSystemListener() {
    const shouldListen = Boolean(currentConfig?.enabled && currentConfig.themeMode === 'system');
    if (shouldListen === systemListenerAttached) return;
    if (shouldListen) {
      colorSchemeQuery.addEventListener('change', queueColorUpdate);
    } else {
      colorSchemeQuery.removeEventListener('change', queueColorUpdate);
    }
    systemListenerAttached = shouldListen;
  }

  function syncFocusListeners() {
    const shouldListen = Boolean(currentConfig?.enabled && currentConfig.windowStateEnabled);
    if (shouldListen === focusListenersAttached) return;
    if (shouldListen) {
      window.addEventListener('focus', onWindowFocus);
      window.addEventListener('blur', onWindowBlur);
      document.addEventListener('visibilitychange', onVisibilityChange);
    } else {
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    focusListenersAttached = shouldListen;
  }

  function restoreOwnedMeta() {
    isApplyingMeta = true;
    try {
      for (const [meta, ownership] of ownedMeta) {
        if (!meta.isConnected || ownership.lastApplied === null) continue;
        if (meta.getAttribute('content') !== ownership.lastApplied) continue;

        if (ownership.extensionCreated) {
          meta.remove();
        } else {
          if (ownership.originalHadContent) {
            if (meta.getAttribute('content') !== ownership.originalContent) {
              meta.setAttribute('content', ownership.originalContent);
            }
          } else if (meta.hasAttribute('content')) {
            meta.removeAttribute('content');
          }
          if (ownership.originalHadMedia && !meta.hasAttribute('media') && ownership.originalMedia !== null) {
            meta.setAttribute('media', ownership.originalMedia);
          }
        }
      }
      ownedMeta.clear();
    } finally {
      isApplyingMeta = false;
    }
  }

  function detachRuntimeListener() {
    if (!runtimeListenerAttached) return;
    if (isExtensionContextValid()) {
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      } catch (_error) {
        runtimeListenerAttached = false;
      }
    }
    runtimeListenerAttached = false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    currentConfig = null;
    disconnectMutationObserver();
    syncSystemListener();
    syncFocusListeners();
    detachRuntimeListener();
    restoreOwnedMeta();
    controller.state = 'disposed';
    if (globalThis[CONTROLLER_KEY] === controller) delete globalThis[CONTROLLER_KEY];
  }

  function configure(data, windowFocused) {
    configGeneration += 1;
    if (typeof windowFocused === 'boolean') {
      isWindowFocused = windowFocused;
    }
    currentConfig = normalizeConfig(data);
    if (!currentConfig.enabled) {
      dispose();
      return;
    }

    controller.state = 'active';
    syncSystemListener();
    syncFocusListeners();
    syncMutationObserver();
    queueColorUpdate();
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (disposed || !isExtensionContextValid()) {
      dispose();
      return;
    }
    if (message?.type === 'colorfulPwaConfigChanged') {
      if (normalizeHostname(message.hostname) !== hostname) {
        sendResponse({ handled: true, stale: true });
        return;
      }
      configure(message.config, message.windowFocused);
      sendResponse({ handled: true });
      return;
    }
    if (message?.type === 'colorfulPwaWindowFocusChanged') {
      if (normalizeHostname(message.hostname) !== hostname) {
        sendResponse({ handled: true, stale: true });
        return;
      }
      if (typeof message.focused === 'boolean') {
        isWindowFocused = message.focused;
        queueColorUpdate();
      }
      sendResponse({ handled: true });
    }
  }

  function fetchResolvedConfig() {
    if (disposed || !isExtensionContextValid()) {
      dispose();
      return;
    }
    const requestGeneration = configGeneration;
    let request;
    try {
      request = chrome.runtime.sendMessage({ type: 'colorfulPwaGetResolvedConfig' });
    } catch (_error) {
      dispose();
      return;
    }
    Promise.resolve(request)
      .then((response) => {
        if (disposed || configGeneration !== requestGeneration) return;
        if (normalizeHostname(response?.hostname) !== hostname) {
          dispose();
          return;
        }
        configure(response.config, response.windowFocused);
      })
      .catch(() => {
        if (!disposed && configGeneration === requestGeneration) dispose();
      });
  }

  if (!isExtensionContextValid()) {
    dispose();
    return;
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  runtimeListenerAttached = true;
  fetchResolvedConfig();
})();
