(() => {
  // Hostnames in the same group are different domains, not parent/subdomain pairs,
  // so they need an explicit alias mapping on top of the suffix inheritance below.
  const ALIAS_GROUPS = [['notebook.google', 'notebook.google.com']];

  function matchesHost(hostname, base) {
    return hostname === base || hostname.endsWith(`.${base}`);
  }

  function getAliasHostname(hostname) {
    if (!hostname) return null;

    for (const group of ALIAS_GROUPS) {
      // Longest base first so a group may contain a nested hostname.
      const bases = [...group].sort((a, b) => b.length - a.length);
      for (const base of bases) {
        if (!matchesHost(hostname, base)) continue;
        const alias = group.find((other) => other !== base);
        if (!alias) return null;
        return `${hostname.slice(0, hostname.length - base.length)}${alias}`;
      }
    }

    return null;
  }

  function getAncestorHostnames(hostname) {
    const labels = hostname.split('.');
    const ancestors = [];
    // A bare public suffix such as `com` must never become a shared parent
    // setting for every unrelated site under that suffix.
    for (let index = 1; index < labels.length - 1; index += 1) {
      ancestors.push(labels.slice(index).join('.'));
    }
    return ancestors;
  }

  // Exact host first, then its alias, then each parent hostname nearest-first with
  // that parent's alias. The first key present in storage wins, so a child config
  // always overrides an inherited parent config.
  function getCandidateKeys(hostname) {
    if (!hostname) return [];

    const keys = [];
    const addKey = (key) => {
      if (key && !keys.includes(key)) keys.push(key);
    };

    addKey(hostname);
    addKey(getAliasHostname(hostname));
    for (const ancestor of getAncestorHostnames(hostname)) {
      addKey(ancestor);
      addKey(getAliasHostname(ancestor));
    }

    return keys;
  }

  function getWriteKeys(hostname) {
    if (!hostname) return [];

    const alias = getAliasHostname(hostname);
    return alias ? [hostname, alias] : [hostname];
  }

  function resolveConfig(hostname, stored) {
    if (!stored) return null;

    for (const key of getCandidateKeys(hostname)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) return stored[key];
    }

    return null;
  }

  function isValidRegistrationHost(hostname) {
    if (typeof hostname !== 'string' || !hostname || hostname !== hostname.toLowerCase()) return false;
    if (hostname.endsWith('.')) return false;
    if (!hostname.includes('.') && hostname !== 'localhost') return false;
    const labels = hostname.split('.');
    if (!labels.every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
      return labels.every((label) => Number(label) <= 255);
    }
    return true;
  }

  function getEnabledRegistrationHosts(stored) {
    const hosts = new Set();
    for (const [hostname, config] of Object.entries(stored ?? {})) {
      if (config?.enabled !== true || !isValidRegistrationHost(hostname)) continue;
      hosts.add(hostname);
      const alias = getAliasHostname(hostname);
      if (alias && isValidRegistrationHost(alias)) hosts.add(alias);
    }

    // A registered parent covers its descendants; background config resolution
    // still applies exact child overrides, including disabled ones.
    const candidates = [...hosts];
    return candidates
      .filter((hostname) => !candidates.some((parent) => parent !== hostname && matchesHost(hostname, parent)))
      .sort();
  }

  globalThis.ColorfulSiteConfig = {
    getAliasHostname,
    getCandidateKeys,
    getWriteKeys,
    resolveConfig,
    getEnabledRegistrationHosts
  };
})();
