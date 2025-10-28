import { fetchTrendingSymbols } from './trendingSymbols.js';
import { logger } from '../utils/logger.js';

const DEFAULT_TTL_MS = 120_000;

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function createEmptyPayload() {
  return { entries: [], totals: [], updatedAt: 0 };
}

function buildMetrics(entry) {
  const changePct =
    toNumber(entry?.changePct24h ?? entry?.changePct ?? entry?.priceChangePercent) ?? null;
  const volatilityPct = toNumber(entry?.volatilityPct24h ?? entry?.volatilityPct) ?? null;
  const quoteVolume =
    toNumber(entry?.quoteVolume24h ?? entry?.quoteVolume ?? entry?.volume) ?? null;
  const baseVolume = toNumber(entry?.baseVolume24h ?? entry?.baseVolume) ?? null;

  return {
    changePct24h: changePct,
    volatilityPct24h: volatilityPct,
    quoteVolume24h: quoteVolume,
    baseVolume24h: baseVolume,
  };
}

function normalizeEntry(entry, fallbackUpdatedAt) {
  const tradingSymbol = typeof entry?.tradingSymbol === 'string' ? entry.tradingSymbol.toUpperCase() : '';
  if (!tradingSymbol) {
    return null;
  }

  const baseSymbol = typeof entry?.symbol === 'string' && entry.symbol
    ? entry.symbol.toUpperCase()
    : tradingSymbol;
  const score = toNumber(entry?.score) ?? toNumber(entry?.z) ?? 0;
  const reasons = Array.isArray(entry?.reasons) ? entry.reasons.filter((reason) => typeof reason === 'string') : [];
  const updatedAt = toNumber(entry?.updatedAt) ?? fallbackUpdatedAt;

  return {
    symbol: baseSymbol,
    tradingSymbol,
    score,
    z: toNumber(entry?.z) ?? score,
    metrics: buildMetrics(entry),
    reasons,
    updatedAt,
  };
}

export function normalizeTrendingHotlistPayload(trending) {
  const updatedAt = Number.isFinite(trending?.updatedAt) ? Number(trending.updatedAt) : Date.now();
  const entries = Array.isArray(trending?.entries) ? trending.entries : [];
  const normalized = [];

  for (const entry of entries) {
    const mapped = normalizeEntry(entry, updatedAt);
    if (mapped) {
      normalized.push(mapped);
    }
  }

  normalized.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  normalized.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return {
    entries: normalized,
    totals: [],
    updatedAt,
  };
}

let cache = { timestamp: 0, payload: createEmptyPayload() };
let inflightFetch = null;

export function __resetInterestHotlistCacheForTests() {
  cache = { timestamp: 0, payload: createEmptyPayload() };
  inflightFetch = null;
}

export async function getInterestHotlist(options = {}) {
  const force = options.force === true;
  const now = Date.now();
  const ttlEnv = Number(process.env.INTEREST_HOTLIST_TTL_MS);
  const ttlMs = Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : DEFAULT_TTL_MS;

  if (!force && cache.payload.entries.length > 0 && now - cache.timestamp < ttlMs) {
    return cache.payload;
  }

  if (!force && inflightFetch) {
    return inflightFetch;
  }

  const fetchPromise = (async () => {
    try {
      const trending = await fetchTrendingSymbols({ force, cacheTtlMs: ttlMs });
      const payload = normalizeTrendingHotlistPayload(trending);
      if (cache.payload.entries.length > 0 && payload.entries.length === 0) {
        return cache.payload;
      }
      cache = { timestamp: Date.now(), payload };
      return payload;
    } catch (error) {
      logger.warn({ error }, 'Failed to refresh interest hotlist');
      if (cache.payload.entries.length > 0) {
        return cache.payload;
      }
      return createEmptyPayload();
    } finally {
      inflightFetch = null;
    }
  })();

  if (!force) {
    inflightFetch = fetchPromise;
  }

  return fetchPromise;
}
