(() => {
  const ALIAS_GROUPS = [['notebook.google', 'notebook.google.com']];

  const COMMON_MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.hk', 'org.hk',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
    'com.tw', 'org.tw', 'edu.tw',
    'com.au', 'net.au', 'org.au',
    'com.sg', 'com.br', 'co.kr', 'co.nz', 'co.in', 'com.mx', 'co.za'
  ]);

  const DEFAULTS = Object.freeze({
    enabled: false,
    windowStateEnabled: false,
    themeMode: 'system',
    activeColor: '#FFFFFF',
    inactiveColor: '#D3D3D3',
    lightActiveColor: '#FFFFFF',
    lightInactiveColor: '#D3D3D3',
    darkActiveColor: '#202124',
    darkInactiveColor: '#303134'
  });

  const PRESETS = Object.freeze([
    Object.freeze({
      id: 'paper-ink',
      name: '原生纸墨',
      colors: Object.freeze({
        lightActiveColor: '#FFFFFF',
        lightInactiveColor: '#EEF0F3',
        darkActiveColor: '#1E1F22',
        darkInactiveColor: '#2B2D31',
        activeColor: '#1E1F22',
        inactiveColor: '#2B2D31'
      })
    }),
    Object.freeze({
      id: 'midnight-indigo',
      name: '午夜靛蓝',
      colors: Object.freeze({
        lightActiveColor: '#F1F5FB',
        lightInactiveColor: '#E2EAF6',
        darkActiveColor: '#0F172A',
        darkInactiveColor: '#1E293B',
        activeColor: '#0F172A',
        inactiveColor: '#1E293B'
      })
    }),
    Object.freeze({
      id: 'warm-espresso',
      name: '暖纸咖啡',
      colors: Object.freeze({
        lightActiveColor: '#FAF6EE',
        lightInactiveColor: '#EFE7DA',
        darkActiveColor: '#231E1A',
        darkInactiveColor: '#322B25',
        activeColor: '#231E1A',
        inactiveColor: '#322B25'
      })
    }),
    Object.freeze({
      id: 'forest-moss',
      name: '森林苔绿',
      colors: Object.freeze({
        lightActiveColor: '#EFF6F2',
        lightInactiveColor: '#DFECE4',
        darkActiveColor: '#12211A',
        darkInactiveColor: '#1D3128',
        activeColor: '#12211A',
        inactiveColor: '#1D3128'
      })
    }),
    Object.freeze({
      id: 'rose-mist',
      name: '樱雾玫瑰',
      colors: Object.freeze({
        lightActiveColor: '#FDF2F4',
        lightInactiveColor: '#F5E2E6',
        darkActiveColor: '#28181D',
        darkInactiveColor: '#3A242B',
        activeColor: '#28181D',
        inactiveColor: '#3A242B'
      })
    }),
    Object.freeze({
      id: 'obsidian-mono',
      name: '极简纯黑',
      colors: Object.freeze({
        lightActiveColor: '#F8FAFC',
        lightInactiveColor: '#E2E8F0',
        darkActiveColor: '#09090B',
        darkInactiveColor: '#18181B',
        activeColor: '#09090B',
        inactiveColor: '#18181B'
      })
    })
  ]);

  function normalizeHostname(rawHostname) {
    if (typeof rawHostname !== 'string') return '';
    let value = rawHostname.trim().toLowerCase();
    if (!value) return '';
    if (value.startsWith('[') && value.endsWith(']')) {
      return value;
    }
    value = value.replace(/\.+$/, '');
    return value;
  }

  function isIPv4(hostname) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
    return hostname.split('.').every((octet) => {
      const numeric = Number(octet);
      return numeric >= 0 && numeric <= 255;
    });
  }

  function isIPv6(hostname) {
    if (!hostname) return false;
    const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return unwrapped.includes(':') && /^[0-9a-f:.]+$/i.test(unwrapped);
  }

  function matchesHost(hostname, base) {
    return hostname === base || hostname.endsWith(`.${base}`);
  }

  function getAliasHostname(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return null;

    for (const group of ALIAS_GROUPS) {
      const bases = [...group].sort((first, second) => second.length - first.length);
      for (const base of bases) {
        if (!matchesHost(normalized, base)) continue;
        const alias = group.find((other) => other !== base);
        if (!alias) return null;
        return `${normalized.slice(0, normalized.length - base.length)}${alias}`;
      }
    }

    return null;
  }

  function getAncestorHostnames(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized || normalized === 'localhost' || isIPv4(normalized) || isIPv6(normalized)) {
      return [];
    }

    const labels = normalized.split('.');
    const ancestors = [];
    for (let index = 1; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      if (COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(candidate)) continue;
      ancestors.push(candidate);
    }
    return ancestors;
  }

  function getCandidateKeys(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return [];

    const keys = [];
    const addKey = (key) => {
      if (key && !keys.includes(key)) keys.push(key);
    };

    addKey(normalized);
    addKey(getAliasHostname(normalized));
    for (const ancestor of getAncestorHostnames(normalized)) {
      addKey(ancestor);
      addKey(getAliasHostname(ancestor));
    }

    return keys;
  }

  function getWriteKeys(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return [];

    const alias = getAliasHostname(normalized);
    return alias ? [normalized, alias] : [normalized];
  }

  function resolveConfigWithMeta(hostname, stored) {
    const normalized = normalizeHostname(hostname);
    const aliasKey = getAliasHostname(normalized);
    const empty = {
      hostname: normalized,
      config: null,
      matchedKey: null,
      source: 'none',
      hasExactOverride: false,
      exactKey: normalized || null,
      aliasKey,
      inheritedFallback: null
    };
    if (!normalized || !stored || typeof stored !== 'object') return empty;

    const candidates = getCandidateKeys(normalized);
    let matchedKey = null;
    let matchedConfig = null;
    let source = 'none';
    let inheritedFallback = null;

    const hasExact = Object.prototype.hasOwnProperty.call(stored, normalized);
    const hasAlias = Boolean(aliasKey && Object.prototype.hasOwnProperty.call(stored, aliasKey));

    for (const key of candidates) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
      const keySource = key === normalized
        ? 'exact'
        : (key === aliasKey ? 'alias' : 'inherited');
      if (!matchedKey) {
        matchedKey = key;
        matchedConfig = stored[key];
        source = keySource;
      } else if (!inheritedFallback && keySource === 'inherited') {
        inheritedFallback = {
          matchedKey: key,
          config: stored[key],
          source: 'inherited'
        };
      }
    }

    return {
      hostname: normalized,
      config: matchedConfig,
      matchedKey,
      source,
      hasExactOverride: hasExact || hasAlias,
      exactKey: normalized,
      aliasKey,
      inheritedFallback
    };
  }

  function resolveConfig(hostname, stored) {
    return resolveConfigWithMeta(hostname, stored).config;
  }

  function normalizeColor(value, fallback = '#FFFFFF') {
    const safeFallback = /^#[0-9A-F]{6}$/i.test(String(fallback ?? ''))
      ? String(fallback).toUpperCase()
      : '#FFFFFF';
    if (typeof value !== 'string') return safeFallback;
    const trimmed = value.trim();
    const shortMatch = /^#([0-9a-f]{3})$/i.exec(trimmed);
    if (shortMatch) {
      const digits = shortMatch[1].toUpperCase();
      return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
    }
    if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
      return trimmed.toUpperCase();
    }
    return safeFallback;
  }

  function hasLegacyConfiguration(data) {
    return ['color', 'activeColor', 'inactiveColor'].some((key) =>
      Object.prototype.hasOwnProperty.call(data, key)
    );
  }

  function normalizeConfig(data) {
    if (!data || typeof data !== 'object') {
      return { ...DEFAULTS };
    }

    const legacyColor = typeof data.color === 'string'
      ? normalizeColor(data.color, DEFAULTS.activeColor)
      : null;
    const activeColor = normalizeColor(
      data.activeColor ?? legacyColor ?? DEFAULTS.activeColor,
      DEFAULTS.activeColor
    );
    const inactiveColor = normalizeColor(
      data.inactiveColor ?? legacyColor ?? activeColor,
      activeColor
    );

    let themeMode;
    if (data.themeMode === 'system' || data.themeMode === 'fixed') {
      themeMode = data.themeMode;
    } else {
      themeMode = hasLegacyConfiguration(data) ? 'fixed' : 'system';
    }

    return {
      enabled: Boolean(data.enabled),
      windowStateEnabled: Boolean(data.windowStateEnabled),
      themeMode,
      activeColor,
      inactiveColor,
      lightActiveColor: normalizeColor(data.lightActiveColor, hasLegacyConfiguration(data) ? activeColor : DEFAULTS.lightActiveColor),
      lightInactiveColor: normalizeColor(data.lightInactiveColor, hasLegacyConfiguration(data) ? inactiveColor : DEFAULTS.lightInactiveColor),
      darkActiveColor: normalizeColor(data.darkActiveColor, hasLegacyConfiguration(data) ? activeColor : DEFAULTS.darkActiveColor),
      darkInactiveColor: normalizeColor(data.darkInactiveColor, hasLegacyConfiguration(data) ? inactiveColor : DEFAULTS.darkInactiveColor)
    };
  }

  function parseHexColor(hexColor) {
    const normalized = normalizeColor(hexColor, '#FFFFFF');
    return {
      red: parseInt(normalized.slice(1, 3), 16),
      green: parseInt(normalized.slice(3, 5), 16),
      blue: parseInt(normalized.slice(5, 7), 16)
    };
  }

  function linearizeChannel(channelValue) {
    const normalized = channelValue / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(hexColor) {
    const { red, green, blue } = parseHexColor(hexColor);
    return 0.2126 * linearizeChannel(red) +
      0.7152 * linearizeChannel(green) +
      0.0722 * linearizeChannel(blue);
  }

  function contrastRatio(firstHex, secondHex) {
    const firstLuminance = relativeLuminance(firstHex);
    const secondLuminance = relativeLuminance(secondHex);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function pickTitleForeground(backgroundHex) {
    const darkInk = '#111827';
    const lightInk = '#F8FAFC';
    const darkRatio = contrastRatio(backgroundHex, darkInk);
    const lightRatio = contrastRatio(backgroundHex, lightInk);
    const useLight = lightRatio >= darkRatio;
    const ratio = useLight ? lightRatio : darkRatio;
    let grade = '低';
    if (ratio >= 7) grade = 'AAA';
    else if (ratio >= 4.5) grade = 'AA';
    else if (ratio >= 3) grade = 'AA+';
    return {
      color: useLight ? lightInk : darkInk,
      ratio: Number(ratio.toFixed(1)),
      grade,
      isDarkBackground: useLight
    };
  }

  function findMatchingPreset(config) {
    const normalized = normalizeConfig(config);
    return PRESETS.find((preset) => {
      if (normalized.themeMode === 'system') {
        return preset.colors.lightActiveColor === normalized.lightActiveColor &&
          preset.colors.lightInactiveColor === normalized.lightInactiveColor &&
          preset.colors.darkActiveColor === normalized.darkActiveColor &&
          preset.colors.darkInactiveColor === normalized.darkInactiveColor;
      }
      return preset.colors.activeColor === normalized.activeColor &&
        preset.colors.inactiveColor === normalized.inactiveColor;
    }) ?? null;
  }

  function isValidRegistrationHost(hostname) {
    if (typeof hostname !== 'string' || !hostname || hostname !== hostname.toLowerCase()) return false;
    if (hostname.endsWith('.')) return false;
    if (isIPv6(hostname)) return false;
    if (!hostname.includes('.') && hostname !== 'localhost') return false;
    const labels = hostname.split('.');
    if (!labels.every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
      return isIPv4(hostname);
    }
    if (COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(hostname)) return false;
    return true;
  }

  function getEnabledRegistrationHosts(stored) {
    const hosts = new Set();
    for (const [rawHostname, config] of Object.entries(stored ?? {})) {
      const normalized = normalizeHostname(rawHostname);
      if (config?.enabled !== true || !isValidRegistrationHost(normalized)) continue;
      hosts.add(normalized);
      const alias = getAliasHostname(normalized);
      if (alias && isValidRegistrationHost(alias)) hosts.add(alias);
    }

    const candidates = [...hosts];
    return candidates
      .filter((hostname) => !candidates.some((parent) => parent !== hostname && matchesHost(hostname, parent)))
      .sort();
  }

  function getStoredSiteEntries(stored) {
    const entries = [];
    const seen = new Set();
    const sortedKeys = Object.keys(stored ?? {}).sort();

    for (const rawKey of sortedKeys) {
      const normalized = normalizeHostname(rawKey);
      if (!normalized || !isValidRegistrationHost(normalized) || seen.has(normalized)) continue;
      const config = normalizeConfig(stored[rawKey]);
      const alias = getAliasHostname(normalized);
      seen.add(normalized);
      let aliasStored = false;
      if (alias && Object.prototype.hasOwnProperty.call(stored, alias)) {
        seen.add(alias);
        aliasStored = true;
      }
      entries.push({
        hostname: normalized,
        aliasHostname: aliasStored ? alias : null,
        removeKeys: getWriteKeys(normalized),
        config
      });
    }

    return entries;
  }

  globalThis.ColorfulSiteConfig = {
    DEFAULTS,
    PRESETS,
    normalizeHostname,
    isIPv4,
    isIPv6,
    getAliasHostname,
    getAncestorHostnames,
    getCandidateKeys,
    getWriteKeys,
    resolveConfigWithMeta,
    resolveConfig,
    normalizeColor,
    normalizeConfig,
    relativeLuminance,
    contrastRatio,
    pickTitleForeground,
    findMatchingPreset,
    isValidRegistrationHost,
    getEnabledRegistrationHosts,
    getStoredSiteEntries
  };
})();
