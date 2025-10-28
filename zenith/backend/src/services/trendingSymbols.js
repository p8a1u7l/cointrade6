import { BinanceClient } from '../clients/binanceClient.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CACHE_TTL_MS = 120_000;
const DEFAULT_LIMIT = 40;

const binance = new BinanceClient();

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toNumber(value, fallback = undefined) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return fallback;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatMagnitude(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const units = [
    { threshold: 1e12, suffix: 'T' },
    { threshold: 1e9, suffix: 'B' },
    { threshold: 1e6, suffix: 'M' },
  ];
  for (const { threshold, suffix } of units) {
    if (value >= threshold) {
      return `${(value / threshold).toFixed(2)}${suffix}`;
    }
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(2)}K`;
  }
  return value.toFixed(2);
}

function inferBaseSymbol(symbol, quoteAsset) {
  if (!symbol || typeof symbol !== 'string') {
    return '';
  }
  const upper = symbol.toUpperCase();
  if (quoteAsset && upper.endsWith(quoteAsset)) {
    return upper.slice(0, upper.length - quoteAsset.length);
  }
  return upper.replace(/(USDT|USDC|USD)$/i, '');
}

function computeTrendScore({ changePct, volatilityPct, quoteVolume }) {
  const volatility = Number.isFinite(volatilityPct) ? Math.max(volatilityPct, 0) : 0;
  const change = Number.isFinite(changePct) ? Math.abs(changePct) : 0;
  const volumeBoost = Number.isFinite(quoteVolume) && quoteVolume > 0 ? Math.log10(quoteVolume + 10) : 0;
  return volatility * 0.6 + change * 0.4 + volumeBoost * 2.4;
}

function buildReasons({ changePct, volatilityPct, quoteVolume }) {
  const reasons = [];
  const changeLabel = formatPercent(changePct);
  if (changeLabel) {
    reasons.push(`24h change ${changeLabel}`);
  }
  if (Number.isFinite(volatilityPct) && volatilityPct >= 1) {
    reasons.push(`24h volatility ${volatilityPct.toFixed(2)}%`);
  }
  const magnitude = formatMagnitude(quoteVolume);
  if (magnitude) {
    reasons.push(`Quote volume ${magnitude}`);
  }
  return reasons.slice(0, 3);
}

export function normalizeTrendingMovers(movers) {
  const now = Date.now();
  if (!Array.isArray(movers) || movers.length === 0) {
    return { entries: [], raw: [], updatedAt: now };
  }

  const entries = [];
  for (let index = 0; index < movers.length; index += 1) {
    const mover = movers[index];
    const tradingSymbol = typeof mover?.symbol === 'string' ? mover.symbol.toUpperCase() : '';
    if (!tradingSymbol) {
      continue;
    }
    const quoteAsset = typeof mover?.quoteAsset === 'string' ? mover.quoteAsset.toUpperCase() : '';
    const changePct = toNumber(mover?.priceChangePercent ?? mover?.changePct24h ?? mover?.changePct);
    const volatilityPct = toNumber(mover?.volatilityPct ?? mover?.rangePct);
    const quoteVolume = toNumber(mover?.quoteVolume ?? mover?.quoteVolume24h ?? mover?.volume);
    const baseVolume = toNumber(mover?.baseVolume ?? mover?.baseVolume24h);
    const direction = mover?.direction === 'down' ? 'down' : 'up';
    const spikeScore = toNumber(mover?.spikeScore);
    const providedScore = toNumber(mover?.score);
    const score = providedScore ?? computeTrendScore({ changePct, volatilityPct, quoteVolume });
    const baseSymbol = inferBaseSymbol(tradingSymbol, quoteAsset);

    entries.push({
      symbol: baseSymbol || tradingSymbol,
      tradingSymbol,
      quoteAsset,
      direction,
      changePct24h: changePct,
      volatilityPct24h: volatilityPct,
      quoteVolume24h: quoteVolume,
      baseVolume24h: baseVolume,
      spikeScore,
      score,
      rank: index + 1,
      reasons: buildReasons({ changePct, volatilityPct, quoteVolume }),
      updatedAt: now,
    });
  }

  entries.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  entries.forEach((entry, idx) => {
    entry.rank = idx + 1;
  });

  return {
    entries,
    raw: movers,
    updatedAt: now,
  };
}

async function defaultProvider(options = {}) {
  const discovery = config?.binance?.symbolDiscovery ?? {};
  const quoteAssets = Array.isArray(options.quoteAssets) && options.quoteAssets.length > 0
    ? options.quoteAssets
    : Array.isArray(discovery.quoteAssets) && discovery.quoteAssets.length > 0
    ? discovery.quoteAssets
    : ['USDT'];
  const minQuoteVolume = Number.isFinite(options.minQuoteVolume)
    ? Number(options.minQuoteVolume)
    : Number(discovery.minQuoteVolume ?? 0);
  const configuredLimit = Number(options.limit ?? discovery.topMoverLimit ?? DEFAULT_LIMIT);
  const limit = clamp(configuredLimit, 10, 100);

  return await binance.fetchTopMovers({
    limit,
    minQuoteVolume,
    quoteAssets,
  });
}

let provider = defaultProvider;

function createEmptyPayload() {
  const now = Date.now();
  return { entries: [], raw: [], updatedAt: now };
}

let cache = {
  timestamp: 0,
  payload: createEmptyPayload(),
};

export function __resetTrendingCacheForTests() {
  cache = { timestamp: 0, payload: createEmptyPayload() };
  provider = defaultProvider;
}

export function __setTrendingProviderForTests(fn) {
  provider = typeof fn === 'function' ? fn : defaultProvider;
  cache = { timestamp: 0, payload: createEmptyPayload() };
}

export async function fetchTrendingSymbols(options = {}) {
  const now = Date.now();
  const ttl = Number.isFinite(options.cacheTtlMs) ? Number(options.cacheTtlMs) : DEFAULT_CACHE_TTL_MS;
  if (!options.force && cache.payload && now - cache.timestamp < ttl) {
    return cache.payload;
  }

  try {
    const movers = await provider(options);
    const payload = normalizeTrendingMovers(movers);
    cache = { timestamp: now, payload };
    return payload;
  } catch (error) {
    logger.warn({ error }, 'Failed to fetch Binance trending symbols');
    if (!cache.payload) {
      cache = { timestamp: now, payload: createEmptyPayload() };
    }
    return cache.payload;
  }
}
