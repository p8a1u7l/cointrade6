import { BinanceClient, BinanceRealtimeFeed } from '../clients/binanceClient.js';
import { requestStrategy } from '../clients/openaiClient.js';
import { AnalyticsRecorder } from '../clients/analyticsRecorder.js';
import { config } from '../config.js';
import { analyticsStore } from '../store/analyticsStore.js';
import { logger } from '../utils/logger.js';
import { TypedEventEmitter } from '../utils/eventEmitter.js';
import { fetchEquitySnapshot } from './equitySnapshot.js';
import { getMarketSnapshot } from './marketIntelligence.js';
import { createBinanceExchangeAdapter } from './scalpExchangeAdapter.js';
import { runScalpLoop, updateScalpInterest } from './scalpSignals.js';
import { fetchTrendingSymbols } from './trendingSymbols.js';
import { alignInterestEntries } from './interestSymbolResolver.js';

const BASE_ORDER_NOTIONAL = 40;
const DEFAULT_CONFIDENCE_GUESS = 0.75;
const MARGIN_USAGE_BUFFER = 0.9;

const CONTEXT_SHIFT_THRESHOLD = 0.12;
const MIN_CONFIDENCE_TO_EXECUTE = 0.62;
const MIN_LOCAL_EDGE = 0.4;
const MIN_LOCAL_CONFIDENCE = 0.55;
const POSITION_EPSILON = 1e-8;
const VALID_SYMBOL_REGEX = /^[A-Z0-9]+$/;
const PERCENT_PRICE_ERROR_REGEX = /percent_price/i;
const MAX_POSITION_ERROR_REGEX = /maximum allowable position/i;

const getErrorMessage = (error) => {
  if (!error) {
    return '';
  }
  if (error instanceof Error) {
    return error.message ?? '';
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_err) {
    return '';
  }
};

const isPercentPriceError = (error) => PERCENT_PRICE_ERROR_REGEX.test(getErrorMessage(error));
const isMaxPositionError = (error) => MAX_POSITION_ERROR_REGEX.test(getErrorMessage(error));
const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const clamp = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
};

function computeContextShift(previous, next) {
  if (!previous || !next) {
    return 0;
  }

  const prevBias = previous?.local_signal?.bias;
  const nextBias = next?.local_signal?.bias;
  if (prevBias && nextBias && prevBias !== nextBias) {
    return Infinity;
  }

  const fields = [
    ['change_5m_pct', 6],
    ['change_15m_pct', 10],
    ['rsi_14', 100],
    ['vol_ratio', 5],
    ['edge_score', 1],
    ['atr_pct', 5],
  ];

  let maxShift = 0;
  for (const [key, scale] of fields) {
    const previousValue = toNumber(previous[key]);
    const nextValue = toNumber(next[key]);
    if (!Number.isFinite(previousValue) || !Number.isFinite(nextValue)) {
      continue;
    }
    const normalized = Math.abs(nextValue - previousValue) / scale;
    if (normalized > maxShift) {
      maxShift = normalized;
    }
  }

  const prevConfidence = toNumber(previous?.local_signal?.confidence);
  const nextConfidence = toNumber(next?.local_signal?.confidence);
  if (Number.isFinite(prevConfidence) && Number.isFinite(nextConfidence)) {
    maxShift = Math.max(maxShift, Math.abs(nextConfidence - prevConfidence));
  }

  return maxShift;
}

export class TradingEngine extends TypedEventEmitter {
  constructor(symbols) {
    super();
    this.baseSymbols = Array.from(
      new Set(
        Array.isArray(symbols)
          ? symbols
              .map((s) => (typeof s === 'string' ? s.toUpperCase() : ''))
              .filter((s) => VALID_SYMBOL_REGEX.test(s))
          : []
      )
    );
    this.activeSymbols = [...this.baseSymbols];
    this.cachedTopMovers = [];
    this.cachedTrending = { updatedAt: 0, entries: [], raw: [] };
    this.lastSymbolRefresh = 0;
    this.riskLevel = 3;
    this.leverageRange = {
      min: config.trading.userControls.minLeverage,
      max: config.trading.userControls.maxLeverage,
    };
    this.allocationRange = {
      min: config.trading.userControls.minAllocationPct,
      max: config.trading.userControls.maxAllocationPct,
    };
    this.userLeverage = config.trading.userControls.defaultLeverage;
    this.allocationPercent = config.trading.userControls.defaultAllocationPct;
    this.running = false;
    this.loopTimer = undefined;
    this.binance = new BinanceClient();
    this.scalpExchange = createBinanceExchangeAdapter(this.binance);
    this.defaultStrategyMode = 'scalp';
    this.strategyMode = this.defaultStrategyMode;
    const configuredMode = config.trading.strategyMode ?? this.defaultStrategyMode;
    config.trading.strategyMode = this.defaultStrategyMode;
    this.recorder = new AnalyticsRecorder();
    this.stream = new BinanceRealtimeFeed();
    this.latestTicks = new Map();
    this.decisionCache = new Map();
    this.positionCache = { timestamp: 0, map: new Map() };
    this.balanceCache = { timestamp: 0, available: 0 };
    this.loopInFlight = false;
    this.aiCooldownMs = 45_000;
    this.aiRevalidationMs = 240_000;
    this.baseSymbolsValidated = false;
    this.blockedSymbols = new Set();
    this._getTrendingSymbols = fetchTrendingSymbols;
    this._updateScalpInterest = updateScalpInterest;
    this.setStrategyMode(configuredMode);

    this.stream.on('tick', (tick) => {
      this.latestTicks.set(tick.symbol, tick);
      this.emit('tick', tick);
    });

  }

  getActiveSymbols() {
    return [...this.activeSymbols];
  }

  getTopMovers() {
    return [...this.cachedTopMovers];
  }

  getTrendingSnapshot() {
    const snapshot = this.cachedTrending ?? { entries: [], raw: [], updatedAt: 0 };
    return {
      updatedAt: snapshot.updatedAt ?? 0,
      entries: Array.isArray(snapshot.entries) ? [...snapshot.entries] : [],
      raw: Array.isArray(snapshot.raw) ? [...snapshot.raw] : [],
    };
  }

  // @deprecated – maintained for compatibility with legacy callers.
  getInterestHotlistSnapshot() {
    return this.getTrendingSnapshot();
  }

  invalidatePositionCache() {
    this.positionCache = { timestamp: 0, map: new Map() };
  }

  async refreshTrendingSymbols(force = false) {
    try {
      const payload = await this._getTrendingSymbols({ force });
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      const raw = Array.isArray(payload?.raw) ? payload.raw : [];
      const updatedAt = Number(payload?.updatedAt) || Date.now();

      let resolvedEntries = entries;
      if (entries.length > 0) {
        try {
          const exchangeInfo = await this.binance.loadExchangeInfo();
          const quotePriority = config.binance.symbolDiscovery?.quoteAssets ?? ['USDT'];
          resolvedEntries = alignInterestEntries(entries, exchangeInfo, quotePriority, {
            onDiscard: (entry) => {
              logger.debug({ entry }, 'Discarded trending entry without tradable Binance symbol');
            },
          });
        } catch (error) {
          logger.warn({ error }, 'Unable to align trending symbols with Binance pairs');
          resolvedEntries = [];
        }
      }

      this.cachedTrending = {
        updatedAt,
        entries: resolvedEntries,
        raw,
      };

      if (this.strategyMode === 'scalp') {
        try {
          await this._updateScalpInterest(resolvedEntries);
        } catch (error) {
          logger.warn({ error }, 'Unable to provide trending symbols to scalping module');
        }
      }

      return this.cachedTrending;
    } catch (error) {
      logger.warn({ error }, 'Failed to refresh Binance trending symbols');
      return this.cachedTrending;
    }
  }

  getStrategyMode() {
    return this.strategyMode;
  }

  setStrategyMode(mode) {
    const normalized = typeof mode === 'string' ? mode.toLowerCase() : '';
    let nextMode = this.defaultStrategyMode;
    if (normalized === 'llm' || normalized === 'scalp') {
      nextMode = normalized;
    } else if (normalized && normalized !== this.defaultStrategyMode) {
      logger.warn(
        { requestedMode: mode },
        'Unknown strategy mode requested, defaulting to base scalping strategy',
      );
    }

    if (nextMode === 'scalp' && !this.scalpExchange) {
      this.scalpExchange = createBinanceExchangeAdapter(this.binance);
    }

    if (this.strategyMode !== nextMode) {
      this.strategyMode = nextMode;
      config.trading.strategyMode = nextMode;
      logger.info({ mode: this.strategyMode }, 'Trading strategy mode updated');
    }

    return this.strategyMode;
  }

  invalidateBalanceCache() {
    this.balanceCache = { timestamp: 0, available: 0 };
  }

  blockSymbol(symbol) {
    if (!symbol) {
      return false;
    }

    const key = symbol.toUpperCase();
    if (this.blockedSymbols.has(key)) {
      return false;
    }

    this.blockedSymbols.add(key);

    const filteredBase = this.baseSymbols.filter((entry) => entry !== key);
    if (filteredBase.length !== this.baseSymbols.length) {
      this.baseSymbols = filteredBase;
      this.baseSymbolsValidated = false;
    }

    const filteredActive = this.activeSymbols.filter((entry) => entry !== key);
    if (filteredActive.length !== this.activeSymbols.length) {
      this._updateActiveSymbols(filteredActive);
    }

    if (Array.isArray(this.cachedTopMovers) && this.cachedTopMovers.length > 0) {
      this.cachedTopMovers = this.cachedTopMovers.filter((item) => item.symbol !== key);
    }

    logger.warn({ symbol: key }, 'Blocked non-tradable symbol from trading universe');
    return true;
  }

  async getPosition(symbol, options = {}) {
    const now = Date.now();
    const ttl = Number.isFinite(options.ttl) ? Number(options.ttl) : 3_000;
    const useCache = !options.forceRefresh && this.positionCache?.map && now - this.positionCache.timestamp < ttl;

    if (!useCache) {
      try {
        const positions = await this.binance.fetchPositions();
        const map = new Map();
        for (const rawPosition of positions ?? []) {
          map.set(rawPosition.symbol, rawPosition);
        }
        this.positionCache = { timestamp: now, map };
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to refresh Binance positions');
        return null;
      }
    }

    const raw = this.positionCache.map.get(symbol);
    return this.projectPosition(symbol, raw);
  }

  projectPosition(symbol, raw) {
    if (!raw || !Number.isFinite(raw.positionAmt) || Math.abs(raw.positionAmt) < POSITION_EPSILON) {
      return null;
    }

    const side = raw.positionAmt > 0 ? 'long' : 'short';
    const quantity = Math.abs(raw.positionAmt);
    const entryPrice = toNumber(raw.entryPrice);

    return {
      symbol,
      side,
      quantity,
      entryPrice,
      raw,
    };
  }

  async getAvailableMargin(options = {}) {
    const now = Date.now();
    const ttl = Number.isFinite(options.ttl) ? Number(options.ttl) : 3_000;
    if (!options.forceRefresh && now - this.balanceCache.timestamp < ttl && Number.isFinite(this.balanceCache.available)) {
      return this.balanceCache.available;
    }

    try {
      const balances = await this.binance.fetchAccountBalance();
      const usdt = balances.find((entry) => entry.asset === 'USDT');
      const available = Number(usdt?.available ?? usdt?.balance ?? 0);
      if (!Number.isFinite(available)) {
        throw new Error('Invalid available balance for USDT');
      }
      this.balanceCache = { timestamp: now, available };
      return available;
    } catch (error) {
      logger.error({ error }, 'Failed to refresh available Binance margin');
      this.balanceCache = { timestamp: now, available: 0 };
      return 0;
    }
  }

  async refreshSymbolUniverse(options = {}) {
    const discovery = config.binance.symbolDiscovery ?? {};
    const enabled = discovery.enabled !== false;

    if (this.blockedSymbols.size > 0) {
      const filteredBase = this.baseSymbols.filter((symbol) => !this.blockedSymbols.has(symbol));
      if (filteredBase.length !== this.baseSymbols.length) {
        this.baseSymbols = filteredBase;
        this.baseSymbolsValidated = false;
      }

      const filteredActive = this.activeSymbols.filter((symbol) => !this.blockedSymbols.has(symbol));
      if (filteredActive.length !== this.activeSymbols.length) {
        this._updateActiveSymbols(filteredActive);
      }
    }

    if (!this.baseSymbolsValidated) {
      try {
        const baseCandidates = this.baseSymbols.filter((symbol) => !this.blockedSymbols.has(symbol));
        const validated = await this.binance.filterTradableSymbols(baseCandidates, discovery.quoteAssets);
        if (validated.length > 0) {
          this.baseSymbols = validated;
          this.activeSymbols = [...validated];
          this.baseSymbolsValidated = true;
        }
      } catch (error) {
        logger.error({ error }, 'Failed to validate base Binance symbols');
      }
    }

    const trendSnapshot = await this.refreshTrendingSymbols(options.force === true);
    const trendSymbols = Array.isArray(trendSnapshot?.entries)
      ? trendSnapshot.entries
          .map((entry) => String(entry?.tradingSymbol ?? '').toUpperCase())
          .filter((symbol) => VALID_SYMBOL_REGEX.test(symbol))
      : [];

    if (!enabled) {
      const merged = Array.from(
        new Set([
          ...trendSymbols.filter((symbol) => !this.blockedSymbols.has(symbol)),
          ...this.baseSymbols,
        ])
      );
      this._updateActiveSymbols(merged);
      return { symbols: this.getActiveSymbols(), movers: [] };
    }

    const now = Date.now();
    const intervalMs = Math.max(30_000, Number(discovery.refreshIntervalSeconds ?? 180) * 1000);
    const force = options.force === true;
    if (!force && now - this.lastSymbolRefresh < intervalMs) {
      if (trendSymbols.length > 0) {
        const merged = Array.from(
          new Set([
            ...trendSymbols.filter((symbol) => !this.blockedSymbols.has(symbol)),
            ...this.activeSymbols,
          ])
        );
        this._updateActiveSymbols(merged);
      }
      return { symbols: this.getActiveSymbols(), movers: this.getTopMovers() };
    }

    const configuredMax = Math.max(Number(discovery.maxActiveSymbols ?? 0), this.baseSymbols.length, 40);
    const fetchLimit = Math.max(
      Number(discovery.topMoverLimit ?? 0),
      20
    );

    try {
      const movers = await this.binance.fetchTopMovers({
        limit: fetchLimit,
        minQuoteVolume: discovery.minQuoteVolume,
        quoteAssets: discovery.quoteAssets,
      });
      this.cachedTopMovers = movers;
      this.lastSymbolRefresh = now;

      const baseSet = new Set(this.baseSymbols);
      const blocked = this.blockedSymbols;
      const dynamicCandidates = movers
        .map((item) => item.symbol)
        .filter((symbol) => !baseSet.has(symbol) && !blocked.has(symbol));
      const routeLimit = Math.max(Number(discovery.routeLimit ?? 0) || 0, 10);
      const dynamicQuota = Math.min(
        dynamicCandidates.length,
        Math.min(Math.max(routeLimit, configuredMax - this.baseSymbols.length), configuredMax)
      );
      const baseQuota = Math.max(0, Math.min(this.baseSymbols.length, configuredMax - dynamicQuota));

      const trimmedBase = [];
      const addBaseSymbol = (symbol) => {
        if (!symbol) return;
        if (!this.baseSymbols.includes(symbol)) return;
        if (blocked.has(symbol)) return;
        if (!trimmedBase.includes(symbol)) {
          trimmedBase.push(symbol);
        }
      };

      ['BTCUSDT', 'ETHUSDT'].forEach((symbol) => addBaseSymbol(symbol));
      for (const symbol of this.baseSymbols) {
        if (trimmedBase.length >= baseQuota) {
          break;
        }
        addBaseSymbol(symbol);
      }

      const prioritizedInterest = trendSymbols.filter((symbol) => !blocked.has(symbol));
      const limitedDynamics = dynamicCandidates.slice(0, dynamicQuota > 0 ? dynamicQuota : routeLimit);
      const nextSymbols = Array.from(new Set([...prioritizedInterest, ...trimmedBase, ...limitedDynamics]));
      if (nextSymbols.length > configuredMax) {
        nextSymbols.length = configuredMax;
      }
      const tradable = await this.binance.filterTradableSymbols(nextSymbols, discovery.quoteAssets);
      const tradableSet = new Set(tradable);
      const suspectSymbols = nextSymbols.filter((symbol) => !tradableSet.has(symbol));
      for (const suspectSymbol of suspectSymbols) {
        try {
          const stillTradable = await this.binance.isSymbolTradable(suspectSymbol, discovery.quoteAssets);
          if (!stillTradable) {
            this.blockSymbol(suspectSymbol);
          }
        } catch (error) {
          logger.debug({ error, symbol: suspectSymbol }, 'Unable to validate candidate symbol during refresh');
        }
      }
      if (tradable.length === 0) {
        logger.warn('Binance symbol scan returned no tradable instruments, falling back to base set');
      }
      const candidate = tradable.length > 0 ? tradable : this.baseSymbols;
      const changed = this._updateActiveSymbols(candidate);

      if (changed) {
        logger.info(
          {
            base: this.baseSymbols.length,
            dynamic: Math.max(candidate.length - this.baseSymbols.length, 0),
            total: candidate.length,
          },
          'Updated active symbol universe from Binance movers scan'
        );
      }

      return { symbols: this.getActiveSymbols(), movers };
    } catch (error) {
      logger.error({ error }, 'Failed to refresh symbol universe');
      if (force && this.activeSymbols.length === 0 && this.baseSymbols.length > 0) {
        this._updateActiveSymbols(this.baseSymbols);
      }
      return { symbols: this.getActiveSymbols(), movers: this.getTopMovers() };
    }
  }

  _updateActiveSymbols(nextSymbols) {
    const blocked = this.blockedSymbols;
    const unique = Array.from(new Set((nextSymbols ?? []).map((symbol) => symbol.toUpperCase()))).filter(
      (symbol) => VALID_SYMBOL_REGEX.test(symbol) && !blocked.has(symbol)
    );
    const changed =
      unique.length !== this.activeSymbols.length ||
      unique.some((symbol, index) => symbol !== this.activeSymbols[index]);
    if (!changed) {
      return false;
    }

    this.activeSymbols = unique;
    const activeSet = new Set(this.activeSymbols);
    for (const key of Array.from(this.latestTicks.keys())) {
      if (!activeSet.has(key)) {
        this.latestTicks.delete(key);
      }
    }
    for (const key of Array.from(this.decisionCache.keys())) {
      if (!activeSet.has(key)) {
        this.decisionCache.delete(key);
      }
    }
    if (this.running) {
      this.stream.start(this.activeSymbols);
    }
    this.emit('symbolsChanged', this.getActiveSymbols());
    return true;
  }

  getRiskLevel() {
    return this.riskLevel;
  }

  getUserLeverage() {
    return this.userLeverage;
  }

  getAllocationPercent() {
    return this.allocationPercent;
  }

  isRunning() {
    return this.running;
  }

  setRiskLevel(level) {
    if (this.riskLevel === level) return;
    this.riskLevel = level;
    this.emit('riskChanged', level);
  }

  setUserLeverage(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error('Leverage must be numeric');
    }
    const clamped = clamp(numeric, this.leverageRange.min, this.leverageRange.max);
    if (this.userLeverage === clamped) {
      return this.userLeverage;
    }
    this.userLeverage = clamped;
    this.emit('leverageChanged', clamped);
    return this.userLeverage;
  }

  setAllocationPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error('Allocation percent must be numeric');
    }
    const clamped = clamp(numeric, this.allocationRange.min, this.allocationRange.max);
    if (this.allocationPercent === clamped) {
      return this.allocationPercent;
    }
    this.allocationPercent = clamped;
    this.emit('allocationChanged', clamped);
    return this.allocationPercent;
  }

  async start() {
    if (this.running) return;
    await this.refreshSymbolUniverse({ force: true });
    if (this.activeSymbols.length === 0) {
      throw new Error('No Binance symbols available to trade');
    }
    this.stream.start(this.activeSymbols);
    try {
      await this.captureEquitySnapshot({ requireSuccess: true });
      this.running = true;
      this.scheduleNextLoop(0);
      this.emit('started');
      logger.info({ symbols: this.getActiveSymbols(), mode: this.strategyMode }, 'Trading engine started');
    } catch (error) {
      this.stream.stop();
      throw error;
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = undefined;
    }
    this.stream.stop();
    this.emit('stopped');
    logger.info('Trading engine stopped');
  }

  scheduleNextLoop(delayMs) {
    if (!this.running) return;
    const timeout = delayMs ?? config.trading.loopIntervalSeconds * 1000;
    this.loopTimer = setTimeout(() => {
      this.executeLoop().catch(this.handleLoopError);
    }, timeout);
  }

  handleLoopError = (error) => {
    logger.error({ error }, 'Trading loop encountered an error');
    this.scheduleNextLoop();
  };

  async runOnce() {
    await this.executeLoop();
  }

  async executeLoop() {
    if (this.loopInFlight) {
      logger.warn('Loop already in flight, skipping runOnce invocation');
      return;
    }
    if (!this.running) return;
    this.loopInFlight = true;
    try {
      await this.refreshSymbolUniverse();
      const symbols = this.getActiveSymbols();
      if (symbols.length === 0) {
        logger.warn('No active symbols available, skipping evaluation loop');
        await this.captureEquitySnapshot();
        return;
      }
      if (this.strategyMode === 'scalp') {
        if (!this.scalpExchange) {
          throw new Error('Scalping mode active but exchange adapter was not initialised');
        }
        for (const symbol of symbols) {
          try {
            await runScalpLoop(this.scalpExchange, symbol);
          } catch (error) {
            logger.error({ error, symbol }, 'Failed to run scalping loop');
          }
        }
      } else {
        for (const symbol of symbols) {
          try {
            const decision = await this.evaluateSymbol(symbol);
            await this.executeDecision(decision);
          } catch (error) {
            logger.error({ error, symbol }, 'Failed to execute trading decision');
          }
        }
      }
      await this.captureEquitySnapshot();
    } finally {
      this.loopInFlight = false;
    }
    this.scheduleNextLoop();
  }

  async evaluateSymbol(symbol) {
    let tradable = false;
    try {
      tradable = await this.binance.isSymbolTradable(symbol, config.binance.symbolDiscovery?.quoteAssets);
    } catch (error) {
      logger.error({ error, symbol }, 'Unable to validate Binance symbol before evaluation');
      return null;
    }

    if (!tradable) {
      this.blockSymbol(symbol);
      return null;
    }

    const tick = this.latestTicks.get(symbol);
    let snapshot;
    try {
      snapshot = await getMarketSnapshot(this.binance, symbol, {
        interval: '1m',
        limit: 150,
      });
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to build market snapshot');
      const cached = this.decisionCache.get(symbol);
      if (cached) {
        const { usage: _usage, ...rest } = cached.decision;
        const fallback = {
          ...rest,
          reasoning: `${rest.reasoning} · Snapshot unavailable, maintaining prior stance`,
        };
        await this.recorder.recordStrategy(fallback, this.riskLevel, {
          leverage: this.getUserLeverage(),
          allocationPct: this.getAllocationPercent(),
        });
        return fallback;
      }
      throw error;
    }

    let contextSnapshot = null;
    if (typeof snapshot.promptContext === 'string' && snapshot.promptContext.length > 0) {
      try {
        contextSnapshot = JSON.parse(snapshot.promptContext);
      } catch (error) {
        logger.debug({ error, symbol }, 'Unable to parse prompt context for strategy evaluation');
      }
    }

    const position = await this.getPosition(symbol);
    const decision = await this.resolveDecision(symbol, snapshot, tick, contextSnapshot, position);
    await this.recorder.recordStrategy(decision, this.riskLevel, {
      leverage: this.getUserLeverage(),
      allocationPct: this.getAllocationPercent(),
    });
    return decision;
  }

  async resolveDecision(symbol, snapshot, tick, contextSnapshot, position) {
    const round = (value, digits = 2) => {
      if (!Number.isFinite(value)) return 0;
      return Number(value.toFixed(digits));
    };

    const clampConfidence = (value, fallback = 0) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return Math.max(0, Math.min(1, fallback));
      }
      return Math.max(0, Math.min(1, numeric));
    };

    const safeRound = (value, digits = 2) => {
      if (!Number.isFinite(value)) {
        return undefined;
      }
      return round(value, digits);
    };

    const trimReasoning = (text, wordLimit = 18) => {
      if (typeof text !== 'string') {
        return undefined;
      }
      const words = text.trim().split(/\s+/);
      if (words.length <= wordLimit) {
        return words.join(' ');
      }
      return `${words.slice(0, wordLimit).join(' ')}...`;
    };

    const summarizePosition = (livePosition, price) => {
      if (!livePosition) {
        return { side: 'flat' };
      }

      const entry = Number(livePosition.entryPrice);
      const priceRef = Number(price);
      let unrealizedPct;
      if (Number.isFinite(entry) && entry > 0 && Number.isFinite(priceRef) && priceRef > 0) {
        const delta = livePosition.side === 'long' ? priceRef - entry : entry - priceRef;
        unrealizedPct = Number(((delta / entry) * 100).toFixed(2));
      }

      return {
        side: livePosition.side,
        quantity: Number.isFinite(livePosition.quantity)
          ? Number(livePosition.quantity.toFixed(4))
          : undefined,
        entryPrice: Number.isFinite(entry) ? Number(entry.toFixed(2)) : undefined,
        unrealizedPct,
      };
    };

    const condensePromptContext = (context, emphasiseLocal) => {
      if (!context || typeof context !== 'object') {
        return null;
      }

      const local = context.local_signal ?? {};
      const localSummary = {
        bias: local.bias ?? null,
        confidence: Number.isFinite(local.confidence) ? round(local.confidence, 2) : undefined,
        edge: Number.isFinite(local.edgeScore) ? round(local.edgeScore, 2) : undefined,
        reasoning: trimReasoning(local.reasoning, emphasiseLocal ? 12 : 18),
      };

      const base = {
        symbol: context.symbol,
        price: safeRound(context.price, 2),
        change_1m_pct: safeRound(context.change_1m_pct, 2),
        change_5m_pct: safeRound(context.change_5m_pct, 2),
        change_15m_pct: safeRound(context.change_15m_pct, 2),
        rsi_14: safeRound(context.rsi_14, 2),
        vol_ratio: safeRound(context.vol_ratio, 2),
        atr_pct: safeRound(context.atr_pct, 3),
        edge_score: safeRound(context.edge_score, 2),
        local_signal: localSummary,
      };

      if (!emphasiseLocal) {
        base.volatility_pct = safeRound(context.volatility_pct, 3);
        base.vol_change_pct = safeRound(context.vol_change_pct, 2);
        base.vol_accel_pct = safeRound(context.vol_accel_pct, 2);
        base.mfi_14 = safeRound(context.mfi_14, 2);
        base.obv_slope_pct = safeRound(context.obv_slope_pct, 2);
        base.support = safeRound(context.support, 2);
        base.resistance = safeRound(context.resistance, 2);
      }

      if (context.ticker_24h && typeof context.ticker_24h === 'object') {
        base.ticker_24h = {
          change_pct: safeRound(context.ticker_24h.change_pct, 2),
          high: safeRound(context.ticker_24h.high, 2),
          low: safeRound(context.ticker_24h.low, 2),
        };
      }

      if (context.derivatives && typeof context.derivatives === 'object') {
        base.derivatives = {
          funding_rate: safeRound(context.derivatives.funding_rate, 4),
          mark_price: safeRound(context.derivatives.mark_price, 2),
          index_price: safeRound(context.derivatives.index_price, 2),
        };
      }

      if (context.open_interest && typeof context.open_interest === 'object') {
        base.open_interest = {
          contracts: safeRound(context.open_interest.contracts, 2),
        };
      }

      if (context.taker_flow && typeof context.taker_flow === 'object') {
        base.taker_flow = {
          ratio: safeRound(context.taker_flow.ratio, 3),
          bias: context.taker_flow.bias,
        };
      }

      base.active_position = summarizePosition(position, context.price ?? priceReference);

      return base;
    };

    const priceReference = snapshot.metrics.lastPrice;
    const localSignal = snapshot.metrics.localSignal;
    const localEdge = Number.isFinite(localSignal?.edgeScore) ? localSignal.edgeScore : 0;
    const localConfidence = clampConfidence(localSignal?.confidence, 0);
    let promptSnapshot = contextSnapshot ?? null;
    if (!promptSnapshot && typeof snapshot.promptContext === 'string' && snapshot.promptContext.length > 0) {
      try {
        promptSnapshot = JSON.parse(snapshot.promptContext);
      } catch (error) {
        logger.warn({ error, symbol }, 'Failed to parse prompt context for cache heuristics');
      }
    }
    const now = Date.now();
    const cached = this.decisionCache.get(symbol);
    const priceDrift = cached?.price
      ? Math.abs((priceReference - cached.price) / cached.price)
      : Infinity;
    const ageMs = cached ? now - cached.timestamp : Infinity;

    const strongLocalSignal =
      localSignal.bias !== 'flat' &&
      ((localSignal.confidence >= 0.68 && localEdge >= 0.48) || localSignal.confidence >= 0.82 || localEdge >= 0.62);

    const ensureActivePosition = (payload) => {
      if (!payload) return null;
      if (typeof payload === 'string') {
        try {
          const parsed = JSON.parse(payload);
          parsed.active_position = summarizePosition(position, priceReference);
          return parsed;
        } catch (error) {
          logger.warn({ error, symbol }, 'Unable to enrich prompt context payload');
          return payload;
        }
      }
      if (typeof payload === 'object') {
        return {
          ...payload,
          active_position: summarizePosition(position, priceReference),
        };
      }
      return payload;
    };

    const contextForAi = ensureActivePosition(
      condensePromptContext(promptSnapshot, strongLocalSignal) ?? snapshot.promptContext
    );

    const applyPositionContext = (decision) => {
      if (!decision) return decision;

      const annotated = { ...decision };
      const livePosition = position;
      if (!livePosition) {
        annotated.livePositionSide = 'flat';
        annotated.livePositionSize = 0;
        annotated.livePositionEntry = undefined;
        if (annotated.action === 'hold') {
          annotated.action = 'entry';
        }
        return annotated;
      }

      annotated.livePositionSide = livePosition.side;
      annotated.livePositionSize = livePosition.quantity;
      annotated.livePositionEntry = livePosition.entryPrice;

      if (Number.isFinite(priceReference) && Number.isFinite(livePosition.entryPrice) && livePosition.entryPrice > 0) {
        const delta = livePosition.side === 'long'
          ? priceReference - livePosition.entryPrice
          : livePosition.entryPrice - priceReference;
        annotated.livePositionUnrealizedPct = Number(((delta / livePosition.entryPrice) * 100).toFixed(2));
      }

      const reasoning = typeof annotated.reasoning === 'string' ? annotated.reasoning : '';

      if (annotated.bias === 'flat' || annotated.action === 'exit') {
        annotated.action = 'exit';
        if (!/Closing/i.test(reasoning)) {
          annotated.reasoning = `${reasoning} · Closing ${livePosition.side} exposure`.trim();
        }
      } else if (annotated.bias === livePosition.side) {
        annotated.action = 'hold';
        if (!/Maintaining/i.test(reasoning)) {
          annotated.reasoning = `${reasoning} · Maintaining ${livePosition.side} position`.trim();
        }
      } else {
        annotated.action = 'flip';
        if (!/Flip/i.test(reasoning)) {
          annotated.reasoning = `${reasoning} · Flip ${livePosition.side}→${annotated.bias}`.trim();
        }
      }

      return annotated;
    };

    const previousContext = cached?.contextSnapshot;
    const hasContextSnapshots = Boolean(previousContext && promptSnapshot);
    const contextShift = hasContextSnapshots ? computeContextShift(previousContext, promptSnapshot) : 0;
    const contextStable = hasContextSnapshots
      ? Number.isFinite(contextShift) && contextShift < CONTEXT_SHIFT_THRESHOLD
      : true;
    const localBiasChanged =
      hasContextSnapshots &&
      previousContext?.local_signal?.bias &&
      promptSnapshot?.local_signal?.bias &&
      previousContext.local_signal.bias !== promptSnapshot.local_signal.bias;

    const stalePrice = !Number.isFinite(priceDrift) || priceDrift >= 0.0012;
    const staleTime = ageMs >= this.aiRevalidationMs;

    let reuseReason;
    if (cached && cached.source === 'openai' && contextStable && !localBiasChanged) {
      if (!stalePrice && !staleTime) {
        reuseReason = 'Maintaining stance';
      } else if (ageMs < this.aiCooldownMs && priceDrift < 0.0025) {
        reuseReason = 'Cooldown reuse';
      }
    }

    if (reuseReason && cached) {
      const driftPct = priceDrift * 100;
      const contextShiftValue = Number.isFinite(contextShift) ? Number(contextShift.toFixed(3)) : null;
      const { usage: _usage, ...rest } = cached.decision;
      const reused = applyPositionContext({
        ...rest,
        reasoning: `${rest.reasoning} · ${reuseReason} (price drift ${round(driftPct, 3)}%)`,
        localEdge,
        localConfidence,
        localBias: localSignal.bias,
        entryPrice: priceReference,
        confidence: clampConfidence(rest.confidence, localConfidence),
      });
      this.decisionCache.set(symbol, {
        ...cached,
        decision: reused,
        price: priceReference,
        timestamp: now,
        contextSnapshot: promptSnapshot ?? cached.contextSnapshot ?? null,
      });
      logger.debug({ symbol, driftPct: round(driftPct, 3), contextShift: contextShiftValue }, 'Reusing cached OpenAI decision');
      return reused;
    }

    const leveragePreset = this.getUserLeverage();
    const estimatedNotional = this.estimateTargetNotional(
      leveragePreset,
      DEFAULT_CONFIDENCE_GUESS,
      this.getCachedAvailableMargin()
    );
    let llmDecision;
    try {
      llmDecision = await requestStrategy(symbol, contextForAi, {
        riskLevel: this.riskLevel,
        leverage: leveragePreset,
        allocationPercent: this.getAllocationPercent(),
        estimatedNotional,
      });
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to request OpenAI decision, applying fallback');

      const fallbackBase = position
        ? {
            symbol,
            bias: 'flat',
            action: 'exit',
            closeBias: position.side,
            confidence: clampConfidence(Math.max(localConfidence, 0.8), 0.8),
            reasoning: 'LLM decision unavailable — flattening via limit exit',
            entryPrice: Number.isFinite(position?.entryPrice) ? position.entryPrice : undefined,
            referencePrice: priceReference,
            timestamp: new Date().toISOString(),
            source: 'fallback',
          }
        : {
            symbol,
            bias: 'flat',
            action: 'hold',
            confidence: clampConfidence(localConfidence, 0.2),
            reasoning: 'LLM decision unavailable — standing aside',
            referencePrice: priceReference,
            timestamp: new Date().toISOString(),
            source: 'fallback',
          };

      const fallbackDecision = applyPositionContext({
        ...fallbackBase,
        localEdge,
        localConfidence,
        localBias: localSignal.bias,
      });

      this.decisionCache.set(symbol, {
        decision: fallbackDecision,
        price: priceReference,
        timestamp: now,
        source: 'fallback',
        contextSnapshot: promptSnapshot ?? null,
      });

      return fallbackDecision;
    }
    const enhanced = {
      ...llmDecision,
      bias: llmDecision.bias ?? localSignal.bias,
      confidence: clampConfidence(llmDecision.confidence, localConfidence || 0.5),
      reasoning: `${llmDecision.reasoning} · ?5m ${round(snapshot.metrics.change5mPct, 2)}%, RSI ${round(
        snapshot.metrics.rsi14,
        1
      )} · Vol ${round(snapshot.metrics.volumeRatio, 2)} · MFI ${round(snapshot.metrics.mfi14, 1)}`,
      localEdge,
      localConfidence,
      localBias: localSignal.bias,
      entryPrice: priceReference,
      promptContextSize:
        typeof contextForAi === 'string'
          ? contextForAi.length
          : JSON.stringify(contextForAi ?? {}).length,
    };
    if (!enhanced.action) {
      enhanced.action = 'entry';
    }

    if (strongLocalSignal) {
      const localSnippet = trimReasoning(localSignal.reasoning, 12);
      const edgePercent = Number.isFinite(localEdge) ? Math.round(localEdge * 100) : undefined;
      const localAnnotationParts = [];
      if (localSnippet) {
        localAnnotationParts.push(localSnippet);
      }
      if (edgePercent !== undefined) {
        localAnnotationParts.push(`edge ${edgePercent}%`);
      }
      localAnnotationParts.push(`confidence ${Math.round(localConfidence * 100)}%`);
      enhanced.reasoning = `${enhanced.reasoning} · Local confirms: ${localAnnotationParts.join(' · ')}`;
      enhanced.confidence = clampConfidence(Math.max(enhanced.confidence, localConfidence));
    }

    if (tick) {
      enhanced.marketTime = new Date(tick.eventTime).toISOString();
    }

    const positionedDecision = applyPositionContext(enhanced);

    this.decisionCache.set(symbol, {
      decision: positionedDecision,
      price: priceReference,
      timestamp: now,
      source: 'openai',
      contextSnapshot: promptSnapshot ?? null,
      model: enhanced.model ?? llmDecision.model ?? 'openai',
    });
    return positionedDecision;
  }

  async executeDecision(decision) {
    if (!decision) {
      logger.info({ decision }, 'Skipping execution due to empty decision');
      return;
    }

    const livePosition = await this.getPosition(decision.symbol);

    if (decision.action === 'exit' || decision.bias === 'flat') {
      await this.executeExit(decision);
      return;
    }

    if (livePosition && decision.bias === livePosition.side) {
      logger.info({ decision }, 'Maintaining existing position aligned with bias');
      return;
    }

    if (livePosition && decision.bias && decision.bias !== livePosition.side) {
      await this.executeExit({
        ...decision,
        action: 'exit',
        closeBias: decision.bias,
        reasoning: `${decision.reasoning ?? ''} · Exiting ${livePosition.side} to flip`,
      });
    }

    if (!this.hasStrongConviction(decision)) {
      logger.info({ decision }, 'Skipping execution due to insufficient conviction');
      return;
    }

    const leverage = this.getUserLeverage();
    const side = decision.bias === 'long' ? 'BUY' : 'SELL';
    const confidence = Number(decision.confidence ?? 0);

    let referencePrice = Number(decision.entryPrice);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      const tick = this.latestTicks.get(decision.symbol);
      if (tick && Number.isFinite(tick.price) && tick.price > 0) {
        referencePrice = tick.price;
      }
    }

    const availableMargin = await this.getAvailableMargin();
    const rawQuantity = this.calculateOrderSize(
      decision.symbol,
      leverage,
      confidence,
      referencePrice,
      availableMargin
    );
    let normalized = await this.binance.ensureTradableQuantity(decision.symbol, rawQuantity, referencePrice);
    let quantity = normalized?.quantity ?? 0;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      logger.warn({ decision, referencePrice, rawQuantity, normalized }, 'Normalized order size invalid, skipping execution');
      return;
    }

    const marginCheck = await this.enforceMarginLimit(
      decision.symbol,
      leverage,
      referencePrice,
      normalized,
      rawQuantity,
      availableMargin
    );
    if (!marginCheck.allowed) {
      logger.warn({ decision, referencePrice, rawQuantity, normalized }, 'Skipping execution due to margin constraints');
      return;
    }

    if (marginCheck.normalized) {
      normalized = marginCheck.normalized;
      quantity = normalized?.quantity ?? quantity;
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      logger.warn({ decision, referencePrice, rawQuantity, normalized }, 'Margin-adjusted quantity invalid, skipping execution');
      return;
    }

    if (Math.abs(quantity - rawQuantity) > Math.max(1e-8, rawQuantity * 0.05)) {
      logger.debug({ decision, rawQuantity, quantity }, 'Adjusted quantity after filters/margin checks');
    }

    await this.binance.setLeverage(decision.symbol, leverage);

    let result;
    try {
      const attempt = await this.placeMarketOrderWithRetries(
        decision,
        side,
        normalized,
        referencePrice,
        rawQuantity
      );
      if (!attempt) {
        logger.warn({ decision, normalized }, 'Market order aborted after retry attempts');
        return;
      }
      result = attempt.result;
      normalized = attempt.normalized ?? normalized;
      quantity = normalized?.quantity ?? quantity;
    } catch (error) {
      this.invalidateBalanceCache();
      if (error instanceof Error && /margin is insufficient/i.test(error.message)) {
        logger.error({ decision, error }, 'Binance rejected order due to insufficient margin after guard');
        return;
      }
      if (isPercentPriceError(error)) {
        logger.error({ decision, error }, 'Binance rejected order due to percent price filter after retries');
        return;
      }
      if (isMaxPositionError(error)) {
        logger.error({ decision, error }, 'Binance rejected order due to leverage bracket after retries');
        return;
      }
      throw error;
    }
    await this.recorder.recordExecution(
      {
        symbol: decision.symbol,
        orderId: String(result.orderId),
        status: result.status,
        filledQty: result.executedQty,
        avgPrice: result.avgPrice,
      },
      {
        ...decision,
        referencePrice,
      }
    );
    this.invalidatePositionCache();
    this.invalidateBalanceCache();
    logger.info({ decision, result }, 'Executed market order');
  }

  async placeMarketOrderWithRetries(decision, side, initialNormalized, referencePrice, rawQuantity) {
    const maxAttempts = 3;
    let attempt = 0;
    let currentNormalized = initialNormalized;
    let currentRawQuantity = rawQuantity;
    let lastError = null;

    while (attempt < maxAttempts) {
      if (!currentNormalized || !Number.isFinite(currentNormalized.quantity) || currentNormalized.quantity <= 0) {
        break;
      }

      const quantityParam = currentNormalized.quantityText ?? currentNormalized.quantity;
      try {
        const result = await this.binance.placeMarketOrder(decision.symbol, side, quantityParam, {
          responseType: 'RESULT',
        });
        if (attempt > 0) {
          logger.debug(
            {
              symbol: decision.symbol,
              attempts: attempt + 1,
              finalQuantity: currentNormalized.quantity,
            },
            'Market order succeeded after retries'
          );
        }
        return { result, normalized: currentNormalized };
      } catch (error) {
        lastError = error;

        if (!(isPercentPriceError(error) || isMaxPositionError(error))) {
          throw error;
        }

        if (attempt >= maxAttempts - 1) {
          break;
        }

        currentRawQuantity *= 0.5;
        if (!Number.isFinite(currentRawQuantity) || currentRawQuantity <= 0) {
          break;
        }

        const nextNormalized = await this.binance.ensureTradableQuantity(
          decision.symbol,
          currentRawQuantity,
          referencePrice
        );

        if (!nextNormalized || !Number.isFinite(nextNormalized.quantity) || nextNormalized.quantity <= 0) {
          break;
        }

        if (
          currentNormalized &&
          Math.abs(nextNormalized.quantity - currentNormalized.quantity) <=
            Math.max(1e-8, currentNormalized.quantity * 1e-4)
        ) {
          break;
        }

        logger.warn(
          {
            symbol: decision.symbol,
            attempt: attempt + 1,
            retryQuantity: nextNormalized.quantity,
            reason: isPercentPriceError(error) ? 'percent_price' : 'max_position',
          },
          'Retrying market order with reduced quantity'
        );

        currentNormalized = nextNormalized;
        attempt += 1;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return null;
  }

  async executeExit(decision) {
    if (!decision?.symbol) {
      logger.warn({ decision }, 'Cannot execute exit without symbol');
      return;
    }

    const position = await this.getPosition(decision.symbol, { forceRefresh: true });
    if (!position) {
      logger.info({ decision }, 'Skipping exit because no active position was found');
      return;
    }

    if (decision.closeBias && decision.closeBias !== position.side) {
      logger.debug({ decision, position }, 'Exit bias differs from live position side');
    }

    const orderSide = position.side === 'long' ? 'SELL' : 'BUY';
    const quantity = Math.abs(position.quantity);
    if (!Number.isFinite(quantity) || quantity <= POSITION_EPSILON) {
      logger.info({ decision, position }, 'Skipping exit due to negligible position size');
      return;
    }

    const tick = this.latestTicks.get(decision.symbol);
    const explicitExitPrice = [
      decision.exitPrice,
      decision.closePrice,
      decision.limitPrice,
      decision.targetPrice,
      decision.orderPrice,
      decision.desiredPrice,
      decision.price,
      decision.referencePrice,
    ]
      .map((value) => toNumber(value))
      .find((value) => Number.isFinite(value) && value > 0);

    const referencePrice = Number.isFinite(explicitExitPrice)
      ? explicitExitPrice
      : Number.isFinite(decision.referencePrice)
      ? decision.referencePrice
      : Number.isFinite(tick?.price)
      ? tick.price
      : undefined;

    const normalized = await this.binance.ensureTradableQuantity(decision.symbol, quantity, referencePrice);
    let exitQuantity = normalized?.quantity ?? quantity;
    if (!Number.isFinite(exitQuantity) || exitQuantity <= 0) {
      logger.warn({ decision, position, normalized }, 'Unable to normalize exit quantity, skipping close');
      return;
    }

    const quantityParam = normalized?.quantityText ?? Number(exitQuantity.toFixed(6));
    const exitPrice = Number.isFinite(explicitExitPrice)
      ? explicitExitPrice
      : Number.isFinite(referencePrice)
      ? referencePrice
      : Number.isFinite(tick?.price)
      ? tick.price
      : Number.isFinite(position.entryPrice)
      ? position.entryPrice
      : undefined;

    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
      logger.warn({ decision, referencePrice, position }, 'Skipping exit due to missing price reference');
      return;
    }

    const result = await this.binance.placeLimitOrder(decision.symbol, orderSide, quantityParam, exitPrice, {
      responseType: 'RESULT',
      reduceOnly: true,
      timeInForce: 'GTC',
    });
    const exitEntryPrice = Number.isFinite(decision.entryPrice)
      ? decision.entryPrice
      : Number.isFinite(position.entryPrice)
      ? position.entryPrice
      : undefined;
    const recorderDecision = {
      ...decision,
      bias: orderSide === 'BUY' ? 'long' : 'short',
      entryPrice: exitEntryPrice,
    };
    const exitReferencePrice = Number.isFinite(decision.referencePrice)
      ? decision.referencePrice
      : Number.isFinite(position.entryPrice)
      ? position.entryPrice
      : undefined;

    await this.recorder.recordExecution(
      {
        symbol: decision.symbol,
        orderId: String(result.orderId),
        status: result.status,
        filledQty: result.executedQty,
        avgPrice: result.avgPrice,
      },
      {
        ...recorderDecision,
        referencePrice: exitReferencePrice,
      }
    );
    this.invalidatePositionCache();
    this.invalidateBalanceCache();
    logger.info({ decision, result, exitPrice }, 'Closed position via strategy exit');
  }

  calculateOrderSize(symbol, leverage, confidence, referencePrice, availableOverride) {
    const targetNotional = this.estimateTargetNotional(
      leverage,
      confidence,
      availableOverride
    );
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      const fallbackQty = Number((targetNotional / 1000).toFixed(6));
      logger.debug({ symbol, fallbackQty }, 'Calculated fallback order size without reference price');
      return fallbackQty;
    }
    const quantity = targetNotional / referencePrice;
    logger.debug({ symbol, quantity, referencePrice, targetNotional }, 'Calculated order size');
    return Number(quantity.toFixed(6));
  }

  async enforceMarginLimit(symbol, leverage, referencePrice, normalized, rawQuantity, availableOverride) {
    const quantity = normalized?.quantity ?? 0;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { allowed: false, normalized };
    }

    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      return { allowed: true, normalized };
    }

    const available = Number.isFinite(availableOverride)
      ? availableOverride
      : await this.getAvailableMargin();
    if (!Number.isFinite(available) || available <= 0) {
      logger.warn({ symbol }, 'Insufficient available margin to open new position');
      return { allowed: false, normalized };
    }

    const effectiveLeverage = Math.max(leverage, 1);
    const marginCap = available * effectiveLeverage * MARGIN_USAGE_BUFFER;
    if (!Number.isFinite(marginCap) || marginCap <= 0) {
      logger.warn({ symbol, available, leverage: effectiveLeverage }, 'Invalid margin ceiling computed for position sizing');
      return { allowed: false, normalized };
    }

    const desiredNotional = quantity * referencePrice;
    let capSource = 'margin';
    let effectiveCap = marginCap;

    try {
      const leverageCap = await this.binance.getMaxNotionalForLeverage(symbol, effectiveLeverage);
      if (Number.isFinite(leverageCap) && leverageCap > 0 && leverageCap < effectiveCap) {
        effectiveCap = leverageCap;
        capSource = 'leverageBracket';
      }
    } catch (error) {
      logger.warn({ error, symbol }, 'Unable to fetch leverage bracket cap, relying on margin cap only');
    }

    if (desiredNotional <= effectiveCap) {
      return { allowed: true, normalized };
    }

    const minNotional = normalized?.filters?.minNotional ?? 0;
    if (effectiveCap > 0 && effectiveCap < minNotional) {
      logger.warn({ symbol, desiredNotional, effectiveCap, minNotional, capSource }, 'Order cap below Binance minimum notional');
      return { allowed: false, normalized: { quantity: 0, quantityText: undefined, filters: normalized?.filters } };
    }

    if (!Number.isFinite(effectiveCap) || effectiveCap <= 0) {
      logger.warn({ symbol, desiredNotional, effectiveCap, capSource }, 'Effective order cap invalid');
      return { allowed: false, normalized };
    }

    const cappedQty = effectiveCap / referencePrice;
    const adjusted = await this.binance.ensureTradableQuantity(symbol, cappedQty, referencePrice);
    const adjustedQty = adjusted?.quantity ?? 0;
    if (!Number.isFinite(adjustedQty) || adjustedQty <= 0) {
      logger.warn({ symbol, desiredNotional, effectiveCap, cappedQty, capSource }, 'Unable to adjust quantity within order cap');
      return { allowed: false, normalized: adjusted ?? normalized };
    }

    const adjustedNotional = adjustedQty * referencePrice;
    logger.info({
      symbol,
      desiredNotional,
      adjustedNotional,
      available,
      leverage: effectiveLeverage,
      rawQuantity,
      adjustedQuantity: adjustedQty,
      capSource,
    }, 'Reduced order size to respect risk caps');

    return { allowed: true, normalized: adjusted };
  }

  getCachedAvailableMargin(ttl = 3_000) {
    const now = Date.now();
    if (now - this.balanceCache.timestamp <= ttl && Number.isFinite(this.balanceCache.available)) {
      return this.balanceCache.available;
    }
    return undefined;
  }

  estimateTargetNotional(leverage, confidence, availableOverride) {
    const safeLeverage = Math.max(Number(leverage) || 1, 1);
    const safeConfidence = Number.isFinite(confidence) ? Math.max(confidence, 0.1) : 0.1;
    const allocationFraction = clamp(this.getAllocationPercent() / 100, 0.01, 1);
    const available = Number.isFinite(availableOverride)
      ? availableOverride
      : this.getCachedAvailableMargin();
    const baseCapitalSource = Number.isFinite(available) && available > 0
      ? available
      : config.trading.initialBalance;
    const capitalBase = Math.max(baseCapitalSource * allocationFraction, BASE_ORDER_NOTIONAL);
    return capitalBase * safeLeverage * safeConfidence;
  }

  hasStrongConviction(decision) {
    const confidence = Number(decision?.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE_TO_EXECUTE) {
      return false;
    }

    const localEdge = Number(decision?.localEdge ?? decision?.edgeScore ?? 0);
    if (!Number.isFinite(localEdge) || localEdge < MIN_LOCAL_EDGE) {
      return false;
    }

    const localConfidence = Number(decision?.localConfidence ?? 0);
    if (Number.isFinite(localConfidence) && localConfidence < MIN_LOCAL_CONFIDENCE) {
      return false;
    }

    return true;
  }

  async captureEquitySnapshot(options = {}) {
    try {
      const baseline = analyticsStore.getBaselineEquity();
      const snapshot = await fetchEquitySnapshot(this.binance, baseline);
      await this.recorder.recordEquity(snapshot);
    } catch (error) {
      logger.error({ error }, 'Failed to capture equity snapshot');
      if (options?.requireSuccess) {
        throw error;
      }
    }
  }
}
