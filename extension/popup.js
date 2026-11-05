(() => {
  const DEFAULTS = {
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

  const ids = {
    enabled: 'enabled',
    windowStateEnabled: 'window-state-enabled',
    activeColor: 'active-color',
    inactiveColor: 'inactive-color',
    lightActiveColor: 'light-active-color',
    lightInactiveColor: 'light-inactive-color',
    darkActiveColor: 'dark-active-color',
    darkInactiveColor: 'dark-inactive-color'
  };

  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const { getCandidateKeys, getWriteKeys, resolveConfig } = globalThis.ColorfulSiteConfig;
  let hostname = '';
  let candidateKeys = [];
  let writeKeys = [];
  let state = { ...DEFAULTS };
  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let unavailable = false;
  let saveGeneration = 0;

  const $ = (id) => document.getElementById(id);
  const modeOptions = document.querySelectorAll('input[name="theme-mode"]');

  function normalizeConfig(data) {
    if (!data) return { ...DEFAULTS };

    const activeColor = data.activeColor ?? data.color ?? DEFAULTS.activeColor;
    const inactiveColor = data.inactiveColor ?? data.color ?? activeColor;
    const hasLegacyColors = ['color', 'activeColor', 'inactiveColor'].some((key) =>
      Object.prototype.hasOwnProperty.call(data, key)
    );

    return {
      enabled: data.enabled ?? false,
      windowStateEnabled: data.windowStateEnabled ?? false,
      themeMode: data.themeMode ?? (hasLegacyColors ? 'fixed' : 'system'),
      activeColor,
      inactiveColor,
      lightActiveColor: data.lightActiveColor ?? activeColor,
      lightInactiveColor: data.lightInactiveColor ?? inactiveColor,
      darkActiveColor: data.darkActiveColor ?? activeColor,
      darkInactiveColor: data.darkInactiveColor ?? inactiveColor
    };
  }

  function render() {
    for (const [key, id] of Object.entries(ids)) {
      const element = $(id);
      if (element.type === 'checkbox') element.checked = Boolean(state[key]);
      else element.value = state[key];
    }

    const systemMode = state.themeMode === 'system';
    const distinguishWindows = Boolean(state.windowStateEnabled);
    for (const option of modeOptions) {
      option.checked = option.value === (systemMode ? 'system' : 'fixed');
    }
    $('system-colors').classList.toggle('hidden', !systemMode);
    $('fixed-colors').classList.toggle('hidden', systemMode);
    document.querySelectorAll('.window-state-specific').forEach((element) => {
      element.classList.toggle('hidden', !distinguishWindows);
    });
    for (const id of ['light-active-label', 'dark-active-label', 'active-label']) {
      $(id).textContent = distinguishWindows ? '活动窗口' : '统一颜色';
    }
    renderAppearance();
    $('appearance').classList.toggle('hidden', !systemMode);
  }

  function readControls() {
    for (const [key, id] of Object.entries(ids)) {
      const element = $(id);
      state[key] = element.type === 'checkbox' ? element.checked : element.value;
    }
    state.themeMode = document.querySelector('input[name="theme-mode"]:checked').value;
  }

  async function saveNow() {
    if (unavailable || !hostname) return false;
    clearTimeout(saveTimer);
    readControls();

    const savedConfig = {
      ...state,
      color: state.activeColor
    };

    const updates = {};
    for (const key of writeKeys) updates[key] = savedConfig;

    const generation = ++saveGeneration;
    $('status').textContent = '保存中…';
    const pendingSave = saveQueue
      .catch(() => {})
      .then(() => chrome.storage.sync.set(updates));
    saveQueue = pendingSave;

    try {
      await pendingSave;
      if (generation === saveGeneration) $('status').textContent = '已保存';
      return true;
    } catch (_error) {
      if (generation === saveGeneration) $('status').textContent = '设置保存失败。';
      return false;
    }
  }

  function scheduleSave() {
    if (unavailable) return;
    $('status').textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 220);
  }

  function disableControls(message) {
    unavailable = true;
    document.querySelectorAll('input').forEach((element) => {
      element.disabled = true;
    });
    $('site-name').textContent = message;
    $('status').textContent = '';
  }

  function enableControls() {
    document.querySelectorAll('input').forEach((element) => {
      element.disabled = false;
    });
  }

  async function initialize() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = tab?.url ? new URL(tab.url) : null;
      if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        disableControls('此页面无法配置。');
        return;
      }

      hostname = url.hostname;
      candidateKeys = getCandidateKeys(hostname);
      writeKeys = getWriteKeys(hostname);
      $('site-name').textContent = hostname;
      const stored = await chrome.storage.sync.get(candidateKeys);
      state = normalizeConfig(resolveConfig(hostname, stored));
      render();
      enableControls();

      for (const input of document.querySelectorAll('input')) {
        if (input.type === 'color') {
          input.addEventListener('input', scheduleSave);
          input.addEventListener('change', () => void saveNow());
        } else {
          input.addEventListener('change', () => {
            readControls();
            render();
            void saveNow();
          });
        }
      }
    } catch (_error) {
      disableControls('无法读取此页面。');
    }
  }

  function renderAppearance() {
    $('appearance').textContent = `系统外观 · ${colorSchemeQuery.matches ? '深色' : '浅色'}`;
  }
  if (typeof colorSchemeQuery.addEventListener === 'function') {
    colorSchemeQuery.addEventListener('change', renderAppearance);
  } else {
    colorSchemeQuery.addListener(renderAppearance);
  }

  initialize();
})();
