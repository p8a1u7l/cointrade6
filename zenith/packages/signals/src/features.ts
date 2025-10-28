import cfg from "@repo/core/config";
import { Features as FeaturesSchema, type Candle } from "@repo/core/schemas";
import type { Features as FeaturesType } from "@repo/core/schemas";

type DepthLevel = [string, string];

const BINANCE_REST_BASE = "https://api.binance.com";

function computeEma(values: number[], period: number): number {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    ema = value * k + ema * (1 - k);
  }
  return ema;
}

function computeRsi(values: number[], period: number): number {
  if (values.length <= period) {
    return 50;
  }
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) {
      gain += delta;
    } else {
      loss -= delta;
    }
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) {
      gain = (gain * (period - 1) + delta) / period;
      loss = (loss * (period - 1)) / period;
    } else {
      gain = (gain * (period - 1)) / period;
      loss = (loss * (period - 1) - delta) / period;
    }
  }
  if (loss === 0) {
    return 100;
  }
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function computeAtr(candles: Candle[], period: number): number {
  if (!Array.isArray(candles) || candles.length === 0) {
    return 0;
  }
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1] ?? current;
    const highLow = current.high - current.low;
    const highClose = Math.abs(current.high - prev.close);
    const lowClose = Math.abs(current.low - prev.close);
    const tr = Math.max(highLow, highClose, lowClose);
    trs.push(tr);
  }
  const window = trs.slice(-period);
  if (window.length === 0) {
    return trs[trs.length - 1] ?? 0;
  }
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

function pickSession(now: Date): "ASIA" | "LONDON" | "NY" | "BRIDGE" {
  const hour = now.getUTCHours();
  if (hour >= 12 && hour < 21) {
    return "NY";
  }
  if (hour >= 7 && hour < 12) {
    return "LONDON";
  }
  if (hour >= 21 || hour < 3) {
    return "ASIA";
  }
  return "BRIDGE";
}

function computeOrderflow(candles: Candle[]) {
  let buy = 0;
  let sell = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    const delta = current.close - prev.close;
    const magnitude = Math.abs(delta) * current.volume;
    if (delta >= 0) {
      buy += magnitude;
    } else {
      sell += magnitude;
    }
  }
  const bubble = buy > sell * 1.8 || sell > buy * 1.8;
  return { buy, sell: sell === 0 ? Math.max(buy * 0.4, 1) : sell, bubble };
}

function aggregateDepth(levels: DepthLevel[]): number {
  if (!Array.isArray(levels)) {
    return 0;
  }
  return levels.slice(0, 10).reduce((sum, [_, qty]) => {
    const size = Number(qty);
    return Number.isFinite(size) ? sum + size : sum;
  }, 0);
}

const exchangeInfoCache = new Map<string, number>();

async function fetchJson(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolveTickSize(symbol: string): Promise<number> {
  const cached = exchangeInfoCache.get(symbol);
  if (Number.isFinite(cached)) {
    return cached as number;
  }
  try {
    const payload = await fetchJson(`${BINANCE_REST_BASE}/api/v3/exchangeInfo?symbol=${symbol}`);
    const info = payload?.symbols?.[0];
    const filter = Array.isArray(info?.filters)
      ? info.filters.find((item: any) => item?.filterType === "PRICE_FILTER")
      : null;
    const tickSize = Number(filter?.tickSize);
    if (Number.isFinite(tickSize) && tickSize > 0) {
      exchangeInfoCache.set(symbol, tickSize);
      return tickSize;
    }
  } catch (error) {
    console.warn(`[signals] Unable to resolve tick size for ${symbol}:`, error);
  }
  const fallback = symbol.endsWith("USDT") ? 0.1 : 1;
  exchangeInfoCache.set(symbol, fallback);
  return fallback;
}

function buildFallbackFvg(
  candles: Candle[],
): Array<{ type: "bullish" | "bearish"; from: number; to: number; size: number }> {
  if (candles.length < 3) {
    return [];
  }
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const gapUp = latest.low > prev.high;
  const gapDown = latest.high < prev.low;
  if (!gapUp && !gapDown) {
    return [];
  }
  const size = gapUp ? latest.low - prev.high : prev.low - latest.high;
  if (!Number.isFinite(size) || size <= 0) {
    return [];
  }
  return [
    {
      type: gapUp ? "bullish" : "bearish",
      from: gapUp ? prev.high : latest.high,
      to: gapUp ? latest.low : prev.low,
      size,
    },
  ];
}

async function buildFallbackFeatures(symbol: string): Promise<FeaturesType> {
  const normalizedSymbol = symbol.toUpperCase();
  const now = Date.now();
  const klinesUrl = `${BINANCE_REST_BASE}/api/v3/klines?symbol=${normalizedSymbol}&interval=1m&limit=120`;
  const depthUrl = `${BINANCE_REST_BASE}/api/v3/depth?symbol=${normalizedSymbol}&limit=10`;
  const tickerUrl = `${BINANCE_REST_BASE}/api/v3/ticker/24hr?symbol=${normalizedSymbol}`;

  const [klinesResult, depthResult, tickerResult] = await Promise.allSettled([
    fetchJson(klinesUrl),
    fetchJson(depthUrl),
    fetchJson(tickerUrl),
  ]);

  const klines: any[] = Array.isArray(klinesResult.status === "fulfilled" ? klinesResult.value : [])
    ? (klinesResult as PromiseFulfilledResult<any[]>).value
    : [];

  const candles: Candle[] = (klines.length > 0 ? klines : []).map((entry) => {
    const [openTime, open, high, low, close, volume] = entry;
    return {
      ts: Number(openTime),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    } satisfies Candle;
  });

  if (candles.length === 0) {
    const basePrice = 25_000;
    for (let i = 0; i < 60; i += 1) {
      const ts = now - (60 - i) * 60_000;
      const price = basePrice + Math.sin(i / 5) * 50;
      candles.push({
        ts,
        open: price,
        high: price + 10,
        low: price - 10,
        close: price + Math.sin(i / 3) * 5,
        volume: 1_000 + i * 5,
      });
    }
  }

  const closes = candles.map((candle) => candle.close);
  const ema25 = computeEma(closes, 25);
  const ema50 = computeEma(closes, 50);
  const ema100 = computeEma(closes, 100);
  const rsi14 = computeRsi(closes, 14);
  const atr22 = computeAtr(candles, 22);

  const highMax = candles.reduce((max, candle) => Math.max(max, candle.high), candles[0].high);
  const lowMin = candles.reduce((min, candle) => Math.min(min, candle.low), candles[0].low);
  const poc = closes.reduce((sum, value) => sum + value, 0) / closes.length;
  const fvg = buildFallbackFvg(candles);

  let bids: DepthLevel[] = [];
  let asks: DepthLevel[] = [];
  if (depthResult.status === "fulfilled" && depthResult.value) {
    bids = Array.isArray(depthResult.value?.bids) ? depthResult.value.bids : [];
    asks = Array.isArray(depthResult.value?.asks) ? depthResult.value.asks : [];
  }

  const bestBid = Number(bids?.[0]?.[0]);
  const bestAsk = Number(asks?.[0]?.[0]);
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : closes[closes.length - 1];
  const spreadBp = Number.isFinite(bestBid) && Number.isFinite(bestAsk) && mid > 0
    ? ((bestAsk - bestBid) / mid) * 10_000
    : 12;

  const micro = {
    spreadBp,
    latencyMs: 80,
    quoteAgeMs: 80,
    bidQty10: aggregateDepth(bids),
    askQty10: aggregateDepth(asks),
  };

  const orderflow = computeOrderflow(candles);

  const ticker = tickerResult.status === "fulfilled" ? tickerResult.value : null;
  const availableUSDT = Number(ticker?.quoteVolume) / Math.max(Number(ticker?.volume) || 1, 1);

  const session = pickSession(new Date(now));
  const regime = ema25 > ema50 && ema50 > ema100 ? "BULLISH" : ema25 < ema50 && ema50 < ema100 ? "BEARISH" : "RANGE";
  const tickSize = await resolveTickSize(normalizedSymbol);
  const lastCandle = candles[candles.length - 1];

  return {
    ts: lastCandle.ts,
    symbol: normalizedSymbol,
    candles,
    ema25,
    ema50,
    ema100,
    rsi14,
    atr22,
    vp: { vah: highMax, val: lowMin, poc },
    fvg,
    fvgAvgSize: fvg.length > 0 ? fvg[0].size : atr22 * 0.5,
    orderflow,
    micro,
    close: lastCandle.close,
    tickSize,
    availableUSDT: Number.isFinite(availableUSDT) && availableUSDT > 0 ? availableUSDT : 1_000,
    session,
    regime,
    candleAgeSec: Math.max(0, Math.round((now - lastCandle.ts) / 1_000)),
    signalAgeSec: Math.max(0, Math.round((now - lastCandle.ts) / 1_000)),
    trades: [],
  } satisfies FeaturesType;
}

export type LiveLast = { close: number; high: number; low: number };
export type FeatureSnapshot = FeaturesType & { liveLast: () => LiveLast };

function resolveEndpoint(symbol: string): string {
  const base = cfg.data?.featureServiceUrl;
  if (!base) {
    throw new Error("feature service URL is not configured");
  }
  if (base.includes("{symbol}")) {
    return base.replace("{symbol}", symbol);
  }
  try {
    const url = new URL(base);
    if (!url.searchParams.has("symbol")) {
      url.searchParams.set("symbol", symbol);
    }
    return url.toString();
  } catch (_err) {
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}symbol=${encodeURIComponent(symbol)}`;
  }
}

function toLiveLast(payload: any, fallback: FeaturesType): LiveLast {
  const source = payload?.live ?? payload?.tick ?? payload;
  const close = Number(source?.close ?? fallback.close);
  const high = Number(source?.high ?? source?.close ?? fallback.close);
  const low = Number(source?.low ?? source?.close ?? fallback.close);
  return {
    close: Number.isFinite(close) ? close : fallback.close,
    high: Number.isFinite(high) ? high : fallback.close,
    low: Number.isFinite(low) ? low : fallback.close,
  };
}

export async function getFeatures(symbol: string): Promise<FeatureSnapshot> {
  const endpoint = resolveEndpoint(symbol);
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`failed to load features for ${symbol}: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    const base = FeaturesSchema.parse(payload) as FeaturesType;
    const snapshot: FeatureSnapshot = Object.assign({}, base, {
      liveLast: () => toLiveLast(payload, base),
    });
    return snapshot;
  } catch (error) {
    console.warn(`[signals] Falling back to synthetic features for ${symbol}:`, error);
    const fallback = await buildFallbackFeatures(symbol);
    const base = FeaturesSchema.parse(fallback) as FeaturesType;
    const snapshot: FeatureSnapshot = Object.assign({}, base, {
      liveLast: () => ({ close: base.close, high: base.candles.at(-1)?.high ?? base.close, low: base.candles.at(-1)?.low ?? base.close }),
    });
    return snapshot;
  }
}
