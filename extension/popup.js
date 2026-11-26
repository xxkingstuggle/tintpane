(() => {
  const {
    DEFAULTS,
    PRESETS,
    normalizeHostname,
    getWriteKeys,
    resolveConfigWithMeta,
    normalizeColor,
    normalizeConfig,
    pickTitleForeground,
    findMatchingPreset,
    isValidRegistrationHost,
    getStoredSiteEntries
  } = globalThis.ColorfulSiteConfig;

  const controlIds = {
    enabled: 'enabled',
    windowStateEnabled: 'window-state-enabled',
    activeColor: 'active-color',
    inactiveColor: 'inactive-color',
    lightActiveColor: 'light-active-color',
    lightInactiveColor: 'light-inactive-color',
    darkActiveColor: 'dark-active-color',
    darkInactiveColor: 'dark-inactive-color'
  };

  const colorKeys = [
    'activeColor',
    'inactiveColor',
    'lightActiveColor',
    'lightInactiveColor',
    'darkActiveColor',
    'darkInactiveColor'
  ];

  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let hostname = '';
  let writeKeys = [];
  let allStored = {};
  let state = { ...DEFAULTS };
  let resolutionMeta = {
    hostname: '',
    config: null,
    matchedKey: null,
    source: 'none',
    hasExactOverride: false,
    exactKey: null,
    aliasKey: null,
    inheritedFallback: null
  };
  let previewScheme = colorSchemeQuery.matches ? 'dark' : 'light';
  let previewSchemePinned = false;
  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let unavailable = false;
  let saveGeneration = 0;
  let hasPendingLocalEdit = false;

  const getById = (id) => document.getElementById(id);
  const modeOptions = document.querySelectorAll('input[name="theme-mode"]');
  const previewSchemeButtons = document.querySelectorAll('[data-preview-scheme]');
  const presetButtons = new Map();

  function buildPresetGrid() {
    const container = getById('presets-grid');
    container.replaceChildren();
    presetButtons.clear();

    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-btn';
      button.dataset.presetId = preset.id;
      button.setAttribute('aria-pressed', 'false');
      button.disabled = true;

      const swatch = document.createElement('span');
      swatch.className = 'preset-swatch';
      swatch.setAttribute('aria-hidden', 'true');

      const lightHalf = document.createElement('span');
      lightHalf.className = 'preset-swatch-half';
      lightHalf.style.backgroundColor = preset.colors.lightActiveColor;

      const darkHalf = document.createElement('span');
      darkHalf.className = 'preset-swatch-half';
      darkHalf.style.backgroundColor = preset.colors.darkActiveColor;

      swatch.append(lightHalf, darkHalf);

      const label = document.createElement('span');
      label.className = 'preset-name';
      label.textContent = preset.name;

      button.append(swatch, label);
      button.addEventListener('click', () => applyPreset(preset));
      container.appendChild(button);
      presetButtons.set(preset.id, button);
    }
  }

  function renderHexTags() {
    for (const key of colorKeys) {
      const tag = getById(`${controlIds[key]}-hex`);
      if (tag) tag.textContent = normalizeColor(state[key], DEFAULTS[key]);
    }
  }

  function renderLivePill() {
    const pill = getById('live-pill');
    const text = getById('live-pill-text');
    if (unavailable) {
      pill.dataset.state = 'unavailable';
      text.textContent = '不可用';
      return;
    }
    if (state.enabled) {
      pill.dataset.state = 'active';
      text.textContent = '已启用';
    } else {
      pill.dataset.state = 'inactive';
      text.textContent = '未启用';
    }
  }

  function renderPreviewWindow(barId, badgeId, backgroundColor) {
    const hex = normalizeColor(backgroundColor, '#FFFFFF');
    const foreground = pickTitleForeground(hex);
    const bar = getById(barId);
    const badge = getById(badgeId);
    bar.style.backgroundColor = hex;
    bar.style.color = foreground.color;
    bar.dataset.darkBg = String(foreground.isDarkBackground);
    badge.textContent = `${hex} · ${foreground.grade} ${foreground.ratio}`;
  }

  function renderPreview() {
    const systemMode = state.themeMode === 'system';
    const distinguishWindows = Boolean(state.windowStateEnabled);
    const effectiveScheme = systemMode ? previewScheme : (colorSchemeQuery.matches ? 'dark' : 'light');

    getById('preview-scheme-toggle').classList.toggle('hidden', !systemMode);
    getById('preview-fixed-tag').classList.toggle('hidden', systemMode);
    for (const button of previewSchemeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.previewScheme === previewScheme));
    }

    const stage = getById('preview-stage');
    stage.dataset.scheme = effectiveScheme;
    stage.classList.toggle('is-muted', !unavailable && !state.enabled);

    const activeColor = systemMode
      ? (previewScheme === 'dark' ? state.darkActiveColor : state.lightActiveColor)
      : state.activeColor;
    const inactiveColor = systemMode
      ? (previewScheme === 'dark' ? state.darkInactiveColor : state.lightInactiveColor)
      : state.inactiveColor;

    const displayHost = hostname || 'Tintpane PWA';
    getById('preview-active-title').textContent = displayHost;
    getById('preview-inactive-title').textContent = displayHost;
    getById('preview-active-role').textContent = distinguishWindows ? '活动' : '统一';

    renderPreviewWindow('preview-active-bar', 'preview-active-badge', activeColor);
    renderPreviewWindow('preview-inactive-bar', 'preview-inactive-badge', inactiveColor);

    getById('preview-inactive').classList.toggle('hidden', !distinguishWindows);
    getById('preview-disabled-note').classList.toggle('hidden', unavailable || state.enabled);
  }

  function renderInheritance() {
    const badge = getById('source-badge');
    const detail = getById('source-detail');
    const resetButton = getById('reset-rule-btn');

    if (unavailable) {
      badge.dataset.source = 'none';
      badge.textContent = '不可配置';
      detail.textContent = '仅支持 HTTP / HTTPS 网页';
      resetButton.classList.add('hidden');
      return;
    }

    badge.dataset.source = resolutionMeta.source;
    if (resolutionMeta.source === 'exact') {
      badge.textContent = resolutionMeta.inheritedFallback ? '独立覆盖' : '站点规则';
      detail.textContent = resolutionMeta.inheritedFallback
        ? `已覆盖父域 ${resolutionMeta.inheritedFallback.matchedKey}`
        : '已为当前主机保存独立配置';
    } else if (resolutionMeta.source === 'alias') {
      badge.textContent = '别名同步';
      detail.textContent = `与 ${resolutionMeta.matchedKey} 共享配置`;
    } else if (resolutionMeta.source === 'inherited') {
      badge.textContent = '继承自父域';
      detail.textContent = `当前继承自 ${resolutionMeta.matchedKey}`;
    } else {
      badge.textContent = '未配置';
      detail.textContent = '默认关闭 · 修改后自动保存';
    }

    if (resolutionMeta.hasExactOverride) {
      resetButton.textContent = resolutionMeta.inheritedFallback ? '恢复继承' : '清除规则';
      resetButton.classList.remove('hidden');
      resetButton.disabled = false;
    } else {
      resetButton.classList.add('hidden');
    }
  }

  function renderPresetSelection() {
    const matched = findMatchingPreset(state);
    getById('preset-hint').textContent = matched ? `当前：${matched.name}` : '自定义';
    for (const [presetId, button] of presetButtons.entries()) {
      button.setAttribute('aria-pressed', String(matched?.id === presetId));
    }
  }

  function renderSitesManager() {
    const entries = getStoredSiteEntries(allStored);
    getById('sites-count').textContent = String(entries.length);

    const list = getById('sites-list');
    list.replaceChildren();

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'sites-empty';
      empty.textContent = '暂无已保存的站点规则';
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'site-item';

      const main = document.createElement('div');
      main.className = 'site-item-main';

      const swatch = document.createElement('span');
      swatch.className = 'preset-swatch';
      swatch.setAttribute('aria-hidden', 'true');

      const leftHalf = document.createElement('span');
      leftHalf.className = 'preset-swatch-half';
      leftHalf.style.backgroundColor = entry.config.themeMode === 'system'
        ? entry.config.lightActiveColor
        : entry.config.activeColor;

      const rightHalf = document.createElement('span');
      rightHalf.className = 'preset-swatch-half';
      rightHalf.style.backgroundColor = entry.config.themeMode === 'system'
        ? entry.config.darkActiveColor
        : entry.config.inactiveColor;

      swatch.append(leftHalf, rightHalf);

      const copy = document.createElement('div');
      copy.className = 'site-item-copy';

      const hostRow = document.createElement('div');
      hostRow.className = 'site-item-host-row';

      const hostLabel = document.createElement('span');
      hostLabel.className = 'site-item-host';
      hostLabel.textContent = entry.hostname;
      hostRow.appendChild(hostLabel);

      if (hostname && (entry.hostname === hostname || entry.aliasHostname === hostname)) {
        const currentBadge = document.createElement('span');
        currentBadge.className = 'current-tag';
        currentBadge.textContent = '当前';
        hostRow.appendChild(currentBadge);
      }

      const meta = document.createElement('div');
      meta.className = 'site-item-meta';
      const modeLabel = entry.config.themeMode === 'system' ? '跟随系统' : '固定配色';
      const statusLabel = entry.config.enabled ? '已启用' : '已停用';
      const aliasText = entry.aliasHostname ? ` · ⇄ ${entry.aliasHostname}` : '';
      meta.textContent = `${statusLabel} · ${modeLabel}${aliasText}`;

      copy.append(hostRow, meta);
      main.append(swatch, copy);

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'site-delete-btn';
      deleteButton.textContent = '删除';
      deleteButton.setAttribute('aria-label', `删除 ${entry.hostname} 的规则`);
      deleteButton.addEventListener('click', () => void removeSiteRule(entry.removeKeys, entry.hostname));

      row.append(main, deleteButton);
      list.appendChild(row);
    }
  }

  function render() {
    for (const [key, id] of Object.entries(controlIds)) {
      const element = getById(id);
      if (element.type === 'checkbox') {
        element.checked = Boolean(state[key]);
      } else {
        element.value = normalizeColor(state[key], DEFAULTS[key]).toLowerCase();
      }
    }

    const systemMode = state.themeMode === 'system';
    const distinguishWindows = Boolean(state.windowStateEnabled);
    for (const option of modeOptions) {
      option.checked = option.value === (systemMode ? 'system' : 'fixed');
    }
    getById('system-colors').classList.toggle('hidden', !systemMode);
    getById('fixed-colors').classList.toggle('hidden', systemMode);
    document.querySelectorAll('.window-state-specific').forEach((element) => {
      element.classList.toggle('hidden', !distinguishWindows);
    });
    for (const id of ['light-active-label', 'dark-active-label', 'active-label']) {
      getById(id).textContent = distinguishWindows ? '活动窗口' : '统一颜色';
    }

    renderHexTags();
    renderLivePill();
    renderPreview();
    renderInheritance();
    renderPresetSelection();
    renderSitesManager();
    renderAppearance();
    getById('appearance').classList.toggle('hidden', !systemMode);
  }

  function readControls() {
    for (const [key, id] of Object.entries(controlIds)) {
      const element = getById(id);
      state[key] = element.type === 'checkbox'
        ? element.checked
        : normalizeColor(element.value, DEFAULTS[key]);
    }
    const checkedMode = document.querySelector('input[name="theme-mode"]:checked');
    state.themeMode = checkedMode?.value === 'fixed' ? 'fixed' : 'system';
  }

  function syncStateFromStorage() {
    if (!hostname) return;
    resolutionMeta = resolveConfigWithMeta(hostname, allStored);
    state = normalizeConfig(resolutionMeta.config);
  }

  function enqueueStorageWork(work) {
    const next = saveQueue.catch(() => {}).then(work);
    saveQueue = next;
    return next;
  }

  async function saveNow(customSuccessMessage = '已保存') {
    if (unavailable || !hostname) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    readControls();

    const savedConfig = {
      ...state,
      color: state.activeColor
    };

    const updates = {};
    const previousEntries = new Map();
    for (const key of writeKeys) {
      previousEntries.set(
        key,
        Object.prototype.hasOwnProperty.call(allStored, key) ? allStored[key] : undefined
      );
      updates[key] = savedConfig;
      allStored[key] = savedConfig;
    }
    resolutionMeta = resolveConfigWithMeta(hostname, allStored);
    renderInheritance();
    renderSitesManager();

    const generation = ++saveGeneration;
    hasPendingLocalEdit = true;
    getById('status').textContent = '保存中…';

    try {
      await enqueueStorageWork(() => chrome.storage.sync.set(updates));
      if (generation === saveGeneration) {
        hasPendingLocalEdit = false;
        getById('status').textContent = customSuccessMessage;
      }
      return true;
    } catch (_error) {
      for (const [key, previousValue] of previousEntries.entries()) {
        if (previousValue === undefined) delete allStored[key];
        else allStored[key] = previousValue;
      }
      syncStateFromStorage();
      render();
      if (generation === saveGeneration) {
        hasPendingLocalEdit = false;
        getById('status').textContent = '设置保存失败。';
      }
      return false;
    }
  }

  async function removeSiteRule(keysToRemove, labelHost) {
    if (!Array.isArray(keysToRemove) || !keysToRemove.length) return;
    const removingCurrent = Boolean(hostname && keysToRemove.some((key) => writeKeys.includes(key)));
    const hadFallback = Boolean(removingCurrent && resolutionMeta.inheritedFallback);
    const generation = ++saveGeneration;
    clearTimeout(saveTimer);
    saveTimer = null;
    hasPendingLocalEdit = true;
    getById('status').textContent = '正在更新规则…';

    try {
      await enqueueStorageWork(() => chrome.storage.sync.remove(keysToRemove));
      for (const key of keysToRemove) delete allStored[key];
      if (removingCurrent) syncStateFromStorage();
      render();
      if (generation === saveGeneration) {
        hasPendingLocalEdit = false;
        if (removingCurrent) {
          getById('status').textContent = hadFallback ? '已恢复继承父域' : '已清除当前站点规则';
        } else {
          getById('status').textContent = `已删除 ${labelHost}`;
        }
      }
    } catch (_error) {
      if (generation === saveGeneration) {
        hasPendingLocalEdit = false;
        getById('status').textContent = '规则删除失败。';
      }
    }
  }

  function applyPreset(preset) {
    if (unavailable || !hostname) return;
    state = {
      ...state,
      ...preset.colors
    };
    render();
    const message = state.enabled
      ? `已套用「${preset.name}」`
      : `已套用「${preset.name}」（开启开关后生效）`;
    void saveNow(message);
  }

  function scheduleSave() {
    if (unavailable) return;
    hasPendingLocalEdit = true;
    getById('status').textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 220);
  }

  function flushPendingSave() {
    if (saveTimer !== null) {
      void saveNow();
    }
  }

  function disableControls(message) {
    unavailable = true;
    document.querySelectorAll('#site-controls input, #system-colors input, #fixed-colors input').forEach((element) => {
      element.disabled = true;
    });
    for (const button of presetButtons.values()) button.disabled = true;
    getById('reset-rule-btn').classList.add('hidden');
    getById('site-name').textContent = message;
    getById('status').textContent = '';
    render();
  }

  function enableControls() {
    document.querySelectorAll('#site-controls input, #system-colors input, #fixed-colors input').forEach((element) => {
      element.disabled = false;
    });
    for (const button of presetButtons.values()) button.disabled = false;
  }

  async function initialize() {
    buildPresetGrid();

    for (const button of previewSchemeButtons) {
      button.addEventListener('click', () => {
        previewScheme = button.dataset.previewScheme === 'dark' ? 'dark' : 'light';
        previewSchemePinned = true;
        renderPreview();
      });
    }

    getById('reset-rule-btn').addEventListener('click', () => {
      if (!unavailable && writeKeys.length) {
        void removeSiteRule(writeKeys, hostname);
      }
    });

    try {
      const [tabs, stored] = await Promise.all([
        chrome.tabs.query({ active: true, lastFocusedWindow: true }),
        chrome.storage.sync.get(null)
      ]);
      allStored = stored ?? {};

      const [tab] = tabs;
      const url = tab?.url ? new URL(tab.url) : null;
      if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        disableControls('此页面无法配置。');
        return;
      }

      hostname = normalizeHostname(url.hostname);
      if (!hostname) {
        disableControls('此页面无法配置。');
        return;
      }
      if (!isValidRegistrationHost(hostname)) {
        disableControls(`暂不支持此主机名（${hostname}）。`);
        return;
      }
      writeKeys = getWriteKeys(hostname);
      getById('site-name').textContent = hostname;
      syncStateFromStorage();
      render();
      enableControls();

      for (const input of document.querySelectorAll('input')) {
        if (input.type === 'color') {
          input.addEventListener('input', () => {
            readControls();
            renderHexTags();
            renderPreview();
            renderPresetSelection();
            scheduleSave();
          });
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
    getById('appearance').textContent = `系统外观 · ${colorSchemeQuery.matches ? '深色' : '浅色'}`;
  }

  function handleSchemeChange() {
    if (!previewSchemePinned) {
      previewScheme = colorSchemeQuery.matches ? 'dark' : 'light';
    }
    renderAppearance();
    renderPreview();
  }

  if (typeof colorSchemeQuery.addEventListener === 'function') {
    colorSchemeQuery.addEventListener('change', handleSchemeChange);
  } else {
    colorSchemeQuery.addListener(handleSchemeChange);
  }

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      for (const [key, change] of Object.entries(changes)) {
        if (Object.prototype.hasOwnProperty.call(change, 'newValue')) {
          allStored[key] = change.newValue;
        } else {
          delete allStored[key];
        }
      }
      if (!unavailable && hostname) {
        resolutionMeta = resolveConfigWithMeta(hostname, allStored);
        if (!hasPendingLocalEdit && saveTimer === null) {
          state = normalizeConfig(resolutionMeta.config);
          render();
          return;
        }
        renderInheritance();
      }
      renderSitesManager();
    });
  }

  window.addEventListener('pagehide', flushPendingSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });

  initialize();
})();
