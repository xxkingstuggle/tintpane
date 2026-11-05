(() => {
  const CONTROLLER_KEY = '__colorfulPwaAutoThemeController';
  if (globalThis[CONTROLLER_KEY]) return;

  const supportedDisplayModes = ['standalone', 'minimal-ui', 'window-controls-overlay'];
  const isPwaWindow = supportedDisplayModes.some((mode) =>
    window.matchMedia(`(display-mode: ${mode})`).matches
  );
  if (!isPwaWindow) return;

  const hostname = window.location.hostname;
  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  let currentConfig = null;
  let configGeneration = 0;
  let disposed = false;
  let updateQueued = false;
  let systemListenerAttached = false;
  let focusListenersAttached = false;
  let runtimeListenerAttached = false;
  const ownedMeta = new Map();

  const controller = { state: 'loading' };
  globalThis[CONTROLLER_KEY] = controller;

  function hasLegacyConfiguration(data) {
    return ['color', 'activeColor', 'inactiveColor'].some((key) =>
      Object.prototype.hasOwnProperty.call(data, key)
    );
  }

  function normalizeConfig(data) {
    if (!data) {
      return {
        enabled: false,
        windowStateEnabled: false,
        themeMode: 'system',
        activeColor: '#FFFFFF',
        inactiveColor: '#D3D3D3',
        lightActiveColor: '#FFFFFF',
        lightInactiveColor: '#D3D3D3',
        darkActiveColor: '#202124',
        darkInactiveColor: '#303134'
      };
    }

    const activeColor = data.activeColor ?? data.color ?? '#FFFFFF';
    const inactiveColor = data.inactiveColor ?? data.color ?? activeColor;

    return {
      enabled: data.enabled ?? false,
      windowStateEnabled: data.windowStateEnabled ?? false,
      themeMode: data.themeMode ?? (hasLegacyConfiguration(data) ? 'fixed' : 'system'),
      activeColor,
      inactiveColor,
      lightActiveColor: data.lightActiveColor ?? activeColor,
      lightInactiveColor: data.lightInactiveColor ?? inactiveColor,
      darkActiveColor: data.darkActiveColor ?? activeColor,
      darkInactiveColor: data.darkInactiveColor ?? inactiveColor
    };
  }

  function getEffectiveColor() {
    if (!currentConfig?.enabled) return null;

    const variant = currentConfig.windowStateEnabled && !document.hasFocus() ? 'Inactive' : 'Active';
    if (currentConfig.themeMode === 'system') {
      const prefix = colorSchemeQuery.matches ? 'dark' : 'light';
      return currentConfig[`${prefix}${variant}Color`];
    }
    return currentConfig[`${variant.toLowerCase()}Color`];
  }

  function setOwnedMetaContent(meta, color, extensionCreated = false) {
    const hadContent = meta.hasAttribute('content');
    const content = meta.getAttribute('content');
    let ownership = ownedMeta.get(meta);

    if (ownership && content !== ownership.lastApplied) {
      ownership.originalHadContent = hadContent;
      ownership.originalContent = content;
      ownership.extensionCreated = false;
    }

    if (content === color) return;

    if (!ownership) {
      ownership = {
        originalHadContent: hadContent,
        originalContent: content,
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
    const color = getEffectiveColor();
    if (!color) return;

    for (const meta of ownedMeta.keys()) {
      if (!meta.isConnected) ownedMeta.delete(meta);
    }

    let metas = [...document.querySelectorAll('meta[name="theme-color"]')];
    if (!metas.length) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
      metas = [meta];
      ownedMeta.set(meta, {
        originalHadContent: false,
        originalContent: null,
        lastApplied: null,
        extensionCreated: true
      });
    }

    for (const meta of metas) setOwnedMetaContent(meta, color, false);
  }

  function queueColorUpdate() {
    if (disposed || updateQueued) return;
    updateQueued = true;
    queueMicrotask(() => {
      updateQueued = false;
      applyColor();
    });
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
      window.addEventListener('focus', queueColorUpdate);
      window.addEventListener('blur', queueColorUpdate);
    } else {
      window.removeEventListener('focus', queueColorUpdate);
      window.removeEventListener('blur', queueColorUpdate);
    }
    focusListenersAttached = shouldListen;
  }

  function restoreOwnedMeta() {
    for (const [meta, ownership] of ownedMeta) {
      if (!meta.isConnected || ownership.lastApplied === null) continue;
      if (meta.getAttribute('content') !== ownership.lastApplied) continue;

      if (ownership.extensionCreated) {
        meta.remove();
      } else if (ownership.originalHadContent) {
        if (meta.getAttribute('content') !== ownership.originalContent) {
          meta.setAttribute('content', ownership.originalContent);
        }
      } else if (meta.hasAttribute('content')) {
        meta.removeAttribute('content');
      }
    }
    ownedMeta.clear();
  }

  function detachRuntimeListener() {
    if (!runtimeListenerAttached) return;
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    runtimeListenerAttached = false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    currentConfig = null;
    syncSystemListener();
    syncFocusListeners();
    detachRuntimeListener();
    restoreOwnedMeta();
    controller.state = 'disposed';
    if (globalThis[CONTROLLER_KEY] === controller) delete globalThis[CONTROLLER_KEY];
  }

  function configure(data) {
    configGeneration += 1;
    currentConfig = normalizeConfig(data);
    if (!currentConfig.enabled) {
      dispose();
      return;
    }

    controller.state = 'active';
    syncSystemListener();
    syncFocusListeners();
    queueColorUpdate();
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'colorfulPwaConfigChanged') return;
    if (message.hostname !== hostname) {
      sendResponse({ handled: true, stale: true });
      return;
    }
    configure(message.config);
    sendResponse({ handled: true });
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  runtimeListenerAttached = true;

  const initialGeneration = configGeneration;
  chrome.runtime.sendMessage({ type: 'colorfulPwaGetResolvedConfig' })
    .then((response) => {
      if (disposed || configGeneration !== initialGeneration) return;
      if (response?.hostname !== hostname) {
        dispose();
        return;
      }
      configure(response.config);
    })
    .catch(() => {
      if (!disposed && configGeneration === initialGeneration) dispose();
    });
})();
