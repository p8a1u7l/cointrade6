const SYMBOL_SANITIZE_REGEX = /[^A-Z0-9]/g;

export function sanitizeInterestSymbol(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.toUpperCase().replace(SYMBOL_SANITIZE_REGEX, '');
  return normalized;
}

const PERMISSION_WHITELIST = new Set(
  ['USDTMARGINEDFUTURES', 'TRD_GRP_005', 'FUTURE'].map((entry) => sanitizeInterestSymbol(entry))
);

function buildQuotePriority(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return ['USDT', 'USDC', 'BUSD'];
  }
  return list.map((entry) => sanitizeInterestSymbol(entry)).filter((entry) => entry.length > 0);
}

function ensureExchangeMap(exchangeInfo) {
  if (!exchangeInfo) {
    return new Map();
  }
  if (exchangeInfo instanceof Map) {
    return exchangeInfo;
  }
  if (exchangeInfo.bySymbol instanceof Map) {
    return exchangeInfo.bySymbol;
  }
  if (exchangeInfo.bySymbol && typeof exchangeInfo.bySymbol === 'object') {
    return new Map(Object.entries(exchangeInfo.bySymbol));
  }
  return new Map();
}

function isTradable(meta, quoteFilter) {
  if (!meta) {
    return false;
  }
  if (meta.status !== 'TRADING') {
    return false;
  }
  if (meta.contractType && meta.contractType !== 'PERPETUAL') {
    return false;
  }
  if (quoteFilter) {
    const quote = sanitizeInterestSymbol(meta.quoteAsset ?? meta.raw?.quoteAsset ?? '');
    if (!quoteFilter.has(quote)) {
      return false;
    }
  }
  if (Array.isArray(meta.permissions) && meta.permissions.length > 0) {
    const normalized = meta.permissions.map((entry) => sanitizeInterestSymbol(entry));
    if (!normalized.some((entry) => PERMISSION_WHITELIST.has(entry))) {
      return false;
    }
  }
  return true;
}

function rankQuote(quote, priority) {
  const idx = priority.indexOf(quote);
  if (idx === -1) {
    return Number.MAX_SAFE_INTEGER;
  }
  return idx;
}

function findByBase(base, bySymbol, quotePriority, quoteFilter) {
  if (!base) {
    return null;
  }
  const matches = [];
  for (const [symbol, meta] of bySymbol.entries()) {
    const metaBase = sanitizeInterestSymbol(meta?.raw?.baseAsset ?? meta?.baseAsset ?? '');
    if (metaBase !== base) {
      continue;
    }
    if (!isTradable(meta, quoteFilter)) {
      continue;
    }
    const quote = sanitizeInterestSymbol(meta.quoteAsset ?? meta.raw?.quoteAsset ?? '');
    matches.push({ symbol, quote });
  }
  if (matches.length === 0) {
    return null;
  }
  matches.sort((a, b) => {
    const rankA = rankQuote(a.quote, quotePriority);
    const rankB = rankQuote(b.quote, quotePriority);
    if (rankA === rankB) {
      return a.symbol.localeCompare(b.symbol);
    }
    return rankA - rankB;
  });
  return matches[0].symbol;
}

export function alignInterestEntries(entries, exchangeInfo, quoteList = [], options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const bySymbol = ensureExchangeMap(exchangeInfo);
  if (bySymbol.size === 0) {
    return [];
  }
  const quotePriority = buildQuotePriority(quoteList);
  const quoteFilter = Array.isArray(quoteList) && quoteList.length > 0
    ? new Set(quotePriority)
    : null;
  const onDiscard = typeof options.onDiscard === 'function' ? options.onDiscard : null;

  const dedup = new Map();
  for (const entry of entries) {
    const baseSymbol = sanitizeInterestSymbol(entry?.symbol ?? '');
    const candidateSymbol = sanitizeInterestSymbol(entry?.tradingSymbol ?? '');
    const candidateBases = new Set();
    if (baseSymbol) {
      candidateBases.add(baseSymbol);
    }

    let resolvedSymbol = '';
    if (candidateSymbol && isTradable(bySymbol.get(candidateSymbol), quoteFilter)) {
      resolvedSymbol = candidateSymbol;
    } else {
      if (candidateSymbol) {
        const meta = bySymbol.get(candidateSymbol);
        const derivedBase = sanitizeInterestSymbol(meta?.raw?.baseAsset ?? meta?.baseAsset ?? '');
        if (derivedBase) {
          candidateBases.add(derivedBase);
        }
      }
      for (const base of candidateBases) {
        const match = findByBase(base, bySymbol, quotePriority, quoteFilter);
        if (match) {
          resolvedSymbol = match;
          break;
        }
      }
    }

    if (!resolvedSymbol) {
      if (onDiscard) {
        onDiscard(entry, 'no-tradable-symbol');
      }
      continue;
    }

    const rawScore = Number(entry?.score);
    const rawZ = Number(entry?.z);
    const score = Number.isFinite(rawScore) ? rawScore : Number.isFinite(rawZ) ? rawZ : 0;
    const z = Number.isFinite(rawZ) ? rawZ : score;
    const updatedAt = Number(entry?.updatedAt);

    const normalized = {
      ...entry,
      symbol: baseSymbol || resolvedSymbol,
      tradingSymbol: resolvedSymbol,
      score,
      z,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    };

    const existing = dedup.get(resolvedSymbol);
    if (!existing || normalized.score > existing.score) {
      dedup.set(resolvedSymbol, normalized);
    }
  }

  const result = Array.from(dedup.values());
  result.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  return result;
}
