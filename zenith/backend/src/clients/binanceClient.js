import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { TypedEventEmitter } from '../utils/eventEmitter.js';

const REST_BASE_URL = config.binance.useTestnet
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

export class BinanceRealtimeFeed extends TypedEventEmitter {
  constructor() {
    super();
    this.pollTimer = undefined;
    this.symbols = [];
  }

  start(symbols) {
    this.stop();
    this.symbols = Array.from(new Set(Array.isArray(symbols) ? symbols : []));
    if (this.symbols.length === 0) {
      return;
    }
    const poll = () => {
      void this._pollPrices(this.symbols);
    };
    poll();
    this.pollTimer = setInterval(poll, 1000);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.symbols = [];
  }

  async _pollPrices(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return;
    }

    if (symbols.length > 40) {
      await this._pollBulkPrices(symbols);
      return;
    }

    for (const symbol of symbols) {
      try {
        const response = await fetch(
          `${REST_BASE_URL}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`
        );
        if (!response.ok) {
          throw new Error(`Binance price request failed: ${response.status}`);
        }
        const payload = await response.json();
        const price = Number(payload.price);
        if (Number.isNaN(price)) {
          throw new Error('Received invalid price from Binance');
        }
        this.emit('tick', {
          symbol: payload.symbol ?? symbol,
          price,
          eventTime: Date.now(),
        });
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to fetch Binance ticker price');
      }
    }
  }

  async _pollBulkPrices(symbols) {
    try {
      const response = await fetch(`${REST_BASE_URL}/fapi/v1/ticker/price`);
      if (!response.ok) {
        throw new Error(`Binance bulk price request failed: ${response.status}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error('Binance bulk price payload was not an array');
      }
      const wanted = new Set(symbols);
      const now = Date.now();
      for (const entry of payload) {
        const symbol = entry?.symbol;
        if (!wanted.has(symbol)) continue;
        const price = Number(entry.price);
        if (Number.isNaN(price)) continue;
        this.emit('tick', {
          symbol,
          price,
          eventTime: now,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to fetch Binance bulk ticker prices');
    }
  }
}

export class BinanceClient {
  constructor() {
    this.baseUrl = REST_BASE_URL;
    this.symbolFilters = new Map();
    this.exchangeInfoCache = { timestamp: 0, ttl: 5 * 60 * 1000, bySymbol: new Map() };
    this.leverageBracketsCache = {
      timestamp: 0,
      ttl: 60 * 1000,
      bySymbol: new Map(),
    };
  }

  async loadExchangeInfo(options = {}) {
    const now = Date.now();
    const ttl = Number.isFinite(options.ttl) ? Number(options.ttl) : this.exchangeInfoCache.ttl;
    const age = now - this.exchangeInfoCache.timestamp;
    if (!options.force && this.exchangeInfoCache.bySymbol.size > 0 && age < ttl) {
      return this.exchangeInfoCache;
    }

    const response = await fetch(`${this.baseUrl}/fapi/v1/exchangeInfo`);
    if (!response.ok) {
      throw new Error(`Binance exchange info request failed: ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.symbols)) {
      throw new Error('Binance exchange info payload was not an array');
    }

    const bySymbol = new Map();
    for (const entry of payload.symbols) {
      if (!entry?.symbol) continue;
      const key = String(entry.symbol).toUpperCase();
      bySymbol.set(key, {
        raw: entry,
        status: entry.status,
        contractType: entry.contractType,
        quoteAsset: entry.quoteAsset,
        permissions: Array.isArray(entry.permissions) ? entry.permissions.map((value) => String(value)) : [],
        filters: Array.isArray(entry.filters) ? entry.filters : [],
        quantityPrecision: Number(entry.quantityPrecision),
      });
    }

    this.exchangeInfoCache = {
      timestamp: now,
      ttl,
      bySymbol,
    };

    return this.exchangeInfoCache;
  }

  async getSymbolMeta(symbol) {
    if (!symbol) return null;
    const cache = await this.loadExchangeInfo();
    return cache.bySymbol.get(symbol.toUpperCase()) ?? null;
  }

  async isSymbolTradable(symbol, quoteAssets = undefined) {
    if (!symbol) {
      return false;
    }

    const cache = await this.loadExchangeInfo();
    const meta = cache.bySymbol.get(symbol.toUpperCase());
    if (!meta) {
      return false;
    }

    const quoteFilter = Array.isArray(quoteAssets) && quoteAssets.length > 0
      ? new Set(quoteAssets.map((asset) => asset.toUpperCase()))
      : undefined;

    return this._isTradablePerpetual(meta, quoteFilter);
  }

  _isTradablePerpetual(meta, quoteFilter) {
    if (!meta) return false;
    if (meta.status !== 'TRADING') return false;
    if (meta.contractType && meta.contractType !== 'PERPETUAL') return false;
    if (quoteFilter && quoteFilter.size > 0 && !quoteFilter.has(String(meta.quoteAsset ?? '').toUpperCase())) {
      return false;
    }
    if (Array.isArray(meta.permissions) && meta.permissions.length > 0) {
      const normalized = meta.permissions.map((value) => String(value).toUpperCase());
      const allowed = ['USDTMARGINEDFUTURES', 'TRD_GRP_005', 'FUTURE'];
      if (!normalized.some((value) => allowed.includes(value))) {
        return false;
      }
    }
    return true;
  }

  async filterTradableSymbols(symbols, quoteAssets = undefined) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return [];
    }
    const cache = await this.loadExchangeInfo();
    const quoteFilter = Array.isArray(quoteAssets) && quoteAssets.length > 0
      ? new Set(quoteAssets.map((asset) => asset.toUpperCase()))
      : undefined;
    const unique = new Set();
    for (const symbol of symbols) {
      const key = typeof symbol === 'string' ? symbol.toUpperCase() : undefined;
      if (!key) continue;
      if (!/^[A-Z0-9]+$/.test(key)) continue;
      if (unique.has(key)) continue;
      const meta = cache.bySymbol.get(key);
      if (this._isTradablePerpetual(meta, quoteFilter)) {
        unique.add(key);
      }
    }
    return Array.from(unique);
  }

  async fetchKlines(symbol, interval = '1m', limit = 120) {
    const params = new URLSearchParams({
      symbol,
      interval,
      limit: String(Math.max(1, Math.min(limit, 500))),
    });
    const response = await fetch(`${this.baseUrl}/fapi/v1/klines?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Binance klines request failed: ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Binance klines payload was not an array');
    }
    return data.map((entry) => ({
      openTime: Number(entry[0]),
      open: Number(entry[1]),
      high: Number(entry[2]),
      low: Number(entry[3]),
      close: Number(entry[4]),
      volume: Number(entry[5]),
      closeTime: Number(entry[6]),
    }));
  }

  async fetchHistoricalKlines(symbol, interval = '1m', options = {}) {
    const maxCandles = Math.max(1, Math.min(Number(options.maxCandles ?? 500), 5000));
    const endTime = options.endTime ? Number(options.endTime) : undefined;
    let cursor = options.startTime ? Number(options.startTime) : undefined;
    let fetched = 0;
    const candles = [];

    while (fetched < maxCandles) {
      const batchLimit = Math.min(500, maxCandles - fetched);
      const params = new URLSearchParams({
        symbol,
        interval,
        limit: String(batchLimit),
      });
      if (cursor !== undefined) {
        params.set('startTime', String(cursor));
      }
      if (endTime !== undefined) {
        params.set('endTime', String(endTime));
      }

      const response = await fetch(`${this.baseUrl}/fapi/v1/klines?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Binance klines request failed: ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      for (const entry of data) {
        candles.push({
          openTime: Number(entry[0]),
          open: Number(entry[1]),
          high: Number(entry[2]),
          low: Number(entry[3]),
          close: Number(entry[4]),
          volume: Number(entry[5]),
          closeTime: Number(entry[6]),
        });
      }

      fetched += data.length;
      const last = candles[candles.length - 1];
      if (!last) {
        break;
      }

      const nextCursor = last.closeTime + 1;
      if (cursor !== undefined && nextCursor <= cursor) {
        break;
      }

      cursor = nextCursor;
      if (endTime !== undefined && cursor > endTime) {
        break;
      }

      if (data.length < batchLimit) {
        break;
      }
    }

    return candles.slice(0, maxCandles);
  }

  async fetch24hTicker(symbol) {
    try {
      const response = await fetch(
        `${this.baseUrl}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`
      );
      if (!response.ok) {
        throw new Error(`Binance 24hr ticker request failed: ${response.status}`);
      }
      const payload = await response.json();
      return {
        priceChangePercent: Number(payload.priceChangePercent ?? 0),
        lastPrice: Number(payload.lastPrice ?? 0),
        openPrice: Number(payload.openPrice ?? 0),
        highPrice: Number(payload.highPrice ?? 0),
        lowPrice: Number(payload.lowPrice ?? 0),
        volume: Number(payload.volume ?? 0),
        quoteVolume: Number(payload.quoteVolume ?? 0),
        closeTime: Number(payload.closeTime ?? Date.now()),
      };
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch Binance 24hr ticker');
      throw error;
    }
  }

  async fetchFundingRate(symbol) {
    try {
      const response = await fetch(
        `${this.baseUrl}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`
      );
      if (!response.ok) {
        throw new Error(`Binance funding rate request failed: ${response.status}`);
      }
      const payload = await response.json();
      return {
        markPrice: Number(payload.markPrice ?? 0),
        indexPrice: Number(payload.indexPrice ?? 0),
        lastFundingRate: Number(payload.lastFundingRate ?? 0),
        nextFundingTime: Number(payload.nextFundingTime ?? 0),
        estimatedSettlePrice: Number(payload.estimatedSettlePrice ?? 0),
      };
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch Binance funding data');
      throw error;
    }
  }

  async fetchOpenInterest(symbol) {
    try {
      const response = await fetch(
        `${this.baseUrl}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`
      );
      if (!response.ok) {
        throw new Error(`Binance open interest request failed: ${response.status}`);
      }
      const payload = await response.json();
      return {
        openInterest: Number(payload.openInterest ?? 0),
        time: Number(payload.time ?? Date.now()),
      };
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch Binance open interest');
      throw error;
    }
  }

  async fetchTakerLongShortRatio(symbol, period = '5m', limit = 12) {
    try {
      const params = new URLSearchParams({
        symbol,
        period,
        limit: String(Math.max(1, Math.min(limit, 500))),
      });
      const response = await fetch(
        `${this.baseUrl}/futures/data/takerlongshortRatio?${params.toString()}`
      );
      if (!response.ok) {
        throw new Error(`Binance taker ratio request failed: ${response.status}`);
      }
      const raw = await response.text();
      if (!raw || raw.trim().length === 0) {
        return [];
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (parseError) {
        logger.warn({ error: parseError, symbol, period, limit }, 'Unable to parse Binance taker ratio payload');
        return [];
      }
      if (!Array.isArray(payload)) {
        logger.warn({ symbol, period, limit }, 'Binance taker ratio payload was not an array');
        return [];
      }
      return payload.map((entry) => ({
        buyVolume: Number(entry.buyVol ?? 0),
        sellVolume: Number(entry.sellVol ?? 0),
        buySellRatio: Number(entry.buySellRatio ?? 0),
        timestamp: Number(entry.timestamp ?? entry.time ?? 0),
      }));
    } catch (error) {
      logger.error({ error, symbol, period, limit }, 'Failed to fetch Binance taker long/short ratio');
      return [];
    }
  }

  signParams(params) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...params, timestamp: String(timestamp) });
    const hmac = crypto.createHmac('sha256', config.binance.apiSecret);
    hmac.update(query.toString());
    query.append('signature', hmac.digest('hex'));
    return query.toString();
  }

  async request(method, path, params = {}) {
    const query = this.signParams(params);
    const url = `${this.baseUrl}${path}?${query}`;
    const response = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': config.binance.apiKey },
    });
    const text = await response.text();
    if (!response.ok) {
      let details = '';
      if (text) {
        try {
          const payload = JSON.parse(text);
          if (payload?.msg) {
            details = ` (${payload.msg})`;
          }
        } catch (_error) {
          details = ` (${text})`;
        }
      }
      throw new Error(`Binance request failed: ${response.status}${details}`);
    }
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      logger.error({ error, path, method }, 'Failed to parse Binance response payload');
      throw error;
    }
  }

  async fetchSymbolFilters(symbol) {
    const key = symbol.toUpperCase();
    if (this.symbolFilters.has(key)) {
      return this.symbolFilters.get(key);
    }

    const meta = await this.getSymbolMeta(key);
    if (!this._isTradablePerpetual(meta)) {
      const received = meta?.raw?.symbol ? String(meta.raw.symbol).toUpperCase() : 'unknown';
      throw new Error(`Exchange info for ${key} not available on Binance (received ${received})`);
    }

    const info = meta.raw ?? {};
    const findFilter = (type) =>
      Array.isArray(info.filters) ? info.filters.find((filter) => filter?.filterType === type) : undefined;

    const parsePrecision = (raw) => {
      if (typeof raw !== 'string') {
        return undefined;
      }
      const [, fractional] = raw.split('.');
      if (!fractional) {
        return 0;
      }
      const trimmed = fractional.replace(/0+$/, '');
      return trimmed.length;
    };

    const marketLotFilter = findFilter('MARKET_LOT_SIZE');
    const lotFilter = findFilter('LOT_SIZE');
    const effectiveLotFilter = marketLotFilter ?? lotFilter;
    const notionalFilter = findFilter('NOTIONAL') ?? findFilter('MIN_NOTIONAL');

    const toNumber = (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    };

    const marketMinQty = toNumber(marketLotFilter?.minQty, 0);
    const lotMinQty = toNumber(lotFilter?.minQty, 0);
    const marketMaxQty = toNumber(marketLotFilter?.maxQty, Number.POSITIVE_INFINITY);
    const lotMaxQty = toNumber(lotFilter?.maxQty, Number.POSITIVE_INFINITY);

    const quantityPrecision = Number.isFinite(Number(meta.quantityPrecision))
      ? Math.max(0, Math.floor(Number(meta.quantityPrecision)))
      : undefined;
    const stepSizePrecision = parsePrecision(effectiveLotFilter?.stepSize ?? lotFilter?.stepSize);

    const filters = {
      stepSize: toNumber(effectiveLotFilter?.stepSize ?? lotFilter?.stepSize, 0),
      minQty: Math.max(marketMinQty, lotMinQty, 0),
      maxQty: Math.min(
        marketMaxQty > 0 ? marketMaxQty : Number.POSITIVE_INFINITY,
        lotMaxQty > 0 ? lotMaxQty : Number.POSITIVE_INFINITY
      ),
      minNotional: toNumber(notionalFilter?.minNotional ?? notionalFilter?.notional, 0),
      maxNotional: toNumber(notionalFilter?.maxNotional, Number.POSITIVE_INFINITY),
      quantityPrecision,
      stepSizePrecision,
    };

    this.symbolFilters.set(key, filters);
    return filters;
  }

  async loadLeverageBrackets(options = {}) {
    const now = Date.now();
    const ttl = Number.isFinite(options.ttl) ? Number(options.ttl) : this.leverageBracketsCache.ttl;
    const age = now - this.leverageBracketsCache.timestamp;
    if (!options.force && this.leverageBracketsCache.bySymbol.size > 0 && age < ttl) {
      return this.leverageBracketsCache;
    }

    const payload = await this.request('GET', '/fapi/v1/leverageBracket');
    if (!Array.isArray(payload)) {
      throw new Error('Binance leverage bracket payload was not an array');
    }

    const bySymbol = new Map();
    for (const entry of payload) {
      if (!entry?.symbol) continue;
      const symbol = String(entry.symbol).toUpperCase();
      const brackets = Array.isArray(entry.brackets)
        ? entry.brackets
            .map((bracket) => ({
              notionalCap: Number(bracket?.notionalCap ?? bracket?.notionalUpper ?? bracket?.cap ?? 0),
              notionalFloor: Number(bracket?.notionalFloor ?? bracket?.notionalLower ?? bracket?.floor ?? 0),
              initialLeverage: Number(bracket?.initialLeverage ?? bracket?.initialLeverageCap ?? 0),
            }))
            .filter((bracket) => Number.isFinite(bracket.notionalCap) && bracket.notionalCap > 0)
        : [];
      bySymbol.set(symbol, brackets);
    }

    this.leverageBracketsCache = {
      timestamp: now,
      ttl,
      bySymbol,
    };

    return this.leverageBracketsCache;
  }

  async getLeverageBracket(symbol) {
    if (!symbol) {
      return [];
    }
    const cache = await this.loadLeverageBrackets();
    return cache.bySymbol.get(symbol.toUpperCase()) ?? [];
  }

  async getMaxNotionalForLeverage(symbol, leverage) {
    const safeLeverage = Math.max(Number(leverage) || 1, 1);
    const brackets = await this.getLeverageBracket(symbol);
    if (!Array.isArray(brackets) || brackets.length === 0) {
      return Number.POSITIVE_INFINITY;
    }

    let bestCap = 0;
    for (const bracket of brackets) {
      if (!Number.isFinite(bracket.initialLeverage) || bracket.initialLeverage <= 0) {
        continue;
      }
      if (bracket.initialLeverage >= safeLeverage) {
        const cap = Number(bracket.notionalCap);
        if (Number.isFinite(cap) && cap > bestCap) {
          bestCap = cap;
        }
      }
    }

    return bestCap > 0 ? bestCap : Number.POSITIVE_INFINITY;
  }

  static quantize(value, stepSize) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isFinite(stepSize) || stepSize <= 0) {
      return Number(value.toFixed(6));
    }
    const precision = Math.min(8, Math.max(0, Math.round(-Math.log10(stepSize))));
    const steps = Math.floor(value / stepSize);
    const quantized = steps * stepSize;
    return Number(quantized.toFixed(precision));
  }

  async ensureTradableQuantity(symbol, desiredQty, referencePrice) {
    if (!Number.isFinite(desiredQty) || desiredQty <= 0) {
      return { quantity: 0, quantityText: undefined, filters: undefined };
    }

    try {
      const filters = await this.fetchSymbolFilters(symbol);
      let quantity = filters.stepSize > 0
        ? BinanceClient.quantize(desiredQty, filters.stepSize)
        : Number(desiredQty);

      if (quantity < filters.minQty) {
        if (filters.stepSize > 0) {
          const minSteps = Math.ceil(filters.minQty / filters.stepSize);
          quantity = BinanceClient.quantize(minSteps * filters.stepSize, filters.stepSize);
        } else {
          quantity = filters.minQty;
        }
      }

      if (Number.isFinite(filters.maxQty) && filters.maxQty > 0 && quantity > filters.maxQty) {
        quantity = filters.maxQty;
      }

      if (Number.isFinite(referencePrice) && referencePrice > 0 && filters.minNotional > 0) {
        const notional = quantity * referencePrice;
        if (notional < filters.minNotional) {
          const requiredQty = filters.minNotional / referencePrice;
          quantity = filters.stepSize > 0
            ? BinanceClient.quantize(requiredQty, filters.stepSize)
            : requiredQty;

          if (Number.isFinite(filters.maxQty) && filters.maxQty > 0 && quantity > filters.maxQty) {
            return { quantity: 0, quantityText: undefined, filters };
          }
        }
      }

      if (Number.isFinite(filters.maxQty) && filters.maxQty > 0 && quantity > filters.maxQty) {
        quantity = filters.maxQty;
      }

      const precisionCaps = [];
      if (Number.isInteger(filters.quantityPrecision)) {
        precisionCaps.push(filters.quantityPrecision);
      }
      if (Number.isInteger(filters.stepSizePrecision)) {
        precisionCaps.push(filters.stepSizePrecision);
      }
      const maxPrecision = precisionCaps.length > 0 ? Math.min(...precisionCaps) : undefined;
      if (Number.isInteger(maxPrecision) && maxPrecision >= 0) {
        const factor = 10 ** maxPrecision;
        quantity = Math.floor(quantity * factor + 1e-12) / factor;
        if (filters.stepSize > 0) {
          quantity = BinanceClient.quantize(quantity, filters.stepSize);
        }
        quantity = Number(quantity.toFixed(Math.min(maxPrecision, 8)));
      } else if (filters.stepSize > 0) {
        quantity = BinanceClient.quantize(quantity, filters.stepSize);
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { quantity: 0, quantityText: undefined, filters };
      }

      if (Number.isFinite(referencePrice) && referencePrice > 0) {
        const notional = quantity * referencePrice;
        if (filters.maxNotional && Number.isFinite(filters.maxNotional) && notional > filters.maxNotional) {
          return { quantity: 0, quantityText: undefined, filters };
        }
        if (filters.minNotional > 0 && notional < filters.minNotional) {
          return { quantity: 0, quantityText: undefined, filters };
        }
      }

      if (quantity < filters.minQty) {
        quantity = filters.stepSize > 0
          ? BinanceClient.quantize(filters.minQty, filters.stepSize)
          : filters.minQty;
      }

      if (!Number.isFinite(quantity) || quantity <= 0 || quantity < filters.minQty) {
        return { quantity: 0, quantityText: undefined, filters };
      }

      const precisionForText = (() => {
        if (Number.isInteger(filters.quantityPrecision)) {
          return Math.max(0, filters.quantityPrecision);
        }
        if (Number.isInteger(filters.stepSizePrecision)) {
          return Math.max(0, filters.stepSizePrecision);
        }
        if (filters.stepSize > 0) {
          const digits = String(filters.stepSize).split('.')[1];
          if (digits) {
            return Math.min(digits.length, 8);
          }
        }
        return 6;
      })();

      const quantityText = Number.isInteger(precisionForText)
        ? quantity.toFixed(Math.min(precisionForText, 8))
        : quantity.toString();

      return {
        quantity: Number(quantityText),
        quantityText,
        filters,
      };
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to normalize Binance quantity');
      return { quantity: 0, quantityText: undefined, filters: undefined };
    }
  }

  async fetchAccountBalance() {
    try {
      const data = await this.request('GET', '/fapi/v2/account');
      return (data.assets ?? []).map((asset) => ({
        asset: asset.asset,
        balance: Number(asset.walletBalance),
        available: Number(asset.availableBalance),
      }));
    } catch (error) {
      logger.error({ error }, 'Unable to fetch Binance account balance');
      throw error;
    }
  }

  async fetchPositions() {
    try {
      const data = await this.request('GET', '/fapi/v2/positionRisk');
      return (data ?? []).map((position) => ({
        symbol: position.symbol,
        positionAmt: Number(position.positionAmt),
        entryPrice: Number(position.entryPrice),
        unrealizedProfit: Number(position.unRealizedProfit ?? position.unrealizedProfit ?? 0),
      }));
    } catch (error) {
      logger.error({ error }, 'Unable to fetch Binance positions');
      throw error;
    }
  }

  async setLeverage(symbol, leverage) {
    try {
      await this.request('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (error) {
      logger.error({ error, symbol, leverage }, 'Failed to set Binance leverage');
      throw error;
    }
  }

  async placeMarketOrder(symbol, side, quantity, options = {}) {
    try {
      const payload = {
        symbol,
        side,
        type: 'MARKET',
        quantity,
        newOrderRespType: options.responseType ?? 'RESULT',
      };

      if (options.reduceOnly === true) {
        payload.reduceOnly = true;
      }

      const data = await this.request('POST', '/fapi/v1/order', payload);
      return {
        orderId: String(data.orderId),
        status: data.status,
        avgPrice: Number(data.avgPrice ?? data.price ?? 0),
        executedQty: Number(data.executedQty ?? data.cumQty ?? data.origQty ?? 0),
      };
    } catch (error) {
      logger.error({ error, symbol, side, quantity }, 'Failed to execute Binance market order');
      throw error;
    }
  }

  async placeLimitOrder(symbol, side, quantity, price, options = {}) {
    try {
      const payload = {
        symbol,
        side,
        type: 'LIMIT',
        quantity,
        price,
        timeInForce: options.timeInForce ?? 'GTC',
        newOrderRespType: options.responseType ?? 'RESULT',
      };

      if (options.reduceOnly === true) {
        payload.reduceOnly = true;
      }

      const data = await this.request('POST', '/fapi/v1/order', payload);
      return {
        orderId: String(data.orderId),
        status: data.status,
        avgPrice: Number(data.avgPrice ?? data.price ?? 0),
        executedQty: Number(data.executedQty ?? data.cumQty ?? data.origQty ?? 0),
      };
    } catch (error) {
      logger.error({ error, symbol, side, quantity, price }, 'Failed to execute Binance limit order');
      throw error;
    }
  }

  async fetchTopMovers(options = {}) {
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
    const minQuoteVolume = Number.isFinite(options.minQuoteVolume)
      ? Number(options.minQuoteVolume)
      : 0;
    const quoteAssets = Array.isArray(options.quoteAssets) && options.quoteAssets.length > 0
      ? options.quoteAssets.map((asset) => asset.toUpperCase())
      : ['USDT'];

    const response = await fetch(`${this.baseUrl}/fapi/v1/ticker/24hr`);
    if (!response.ok) {
      throw new Error(`Binance 24hr ticker request failed: ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Binance 24hr ticker payload was not an array');
    }

    const cache = await this.loadExchangeInfo();
    const quoteFilter = new Set(quoteAssets);
    const tradableSet = new Set(
      Array.from(cache.bySymbol.entries())
        .filter(([, meta]) => this._isTradablePerpetual(meta, quoteFilter))
        .map(([key]) => key)
    );

    const ranked = [];
    for (const entry of data) {
      const symbol = typeof entry.symbol === 'string' ? entry.symbol.toUpperCase() : undefined;
      if (!symbol) continue;
      if (!/^[A-Z0-9]+$/.test(symbol)) {
        continue;
      }
      const matchingQuote = quoteAssets.find((asset) => symbol.endsWith(asset));
      if (!matchingQuote) continue;
      if (!tradableSet.has(symbol)) continue;

      const priceChangePercent = Number(entry.priceChangePercent ?? entry.priceChange_pct ?? entry.priceChange);
      const lastPrice = Number(entry.lastPrice ?? entry.prevClosePrice ?? entry.close ?? entry.price);
      const quoteVolume = Number(entry.quoteVolume ?? entry.volume ?? 0);
      const baseVolume = Number(entry.volume ?? 0);

      if (
        !Number.isFinite(priceChangePercent) ||
        !Number.isFinite(lastPrice) ||
        !Number.isFinite(quoteVolume)
      ) {
        continue;
      }
      if (quoteVolume < minQuoteVolume) {
        continue;
      }

      const highPrice = Number(entry.highPrice ?? entry.high ?? 0);
      const lowPrice = Number(entry.lowPrice ?? entry.low ?? 0);
      let rangePct = 0;
      if (
        Number.isFinite(highPrice) &&
        Number.isFinite(lowPrice) &&
        highPrice > 0 &&
        lowPrice > 0 &&
        highPrice > lowPrice
      ) {
        const midpoint = (highPrice + lowPrice) / 2;
        if (midpoint > 0) {
          rangePct = ((highPrice - lowPrice) / midpoint) * 100;
        }
      }

      const changeMagnitude = Math.abs(priceChangePercent);
      const volatilityScore = rangePct * 0.55 + changeMagnitude * 0.45;
      const spikeScore = changeMagnitude >= 12
        ? changeMagnitude ** 1.08
        : changeMagnitude ** 1.02;
      const imbalanceScore = Math.max(rangePct - changeMagnitude * 0.35, 0);
      const volumeBoost = 1 + Math.log10(Math.max(quoteVolume, 1) + 10) / 8;
      const directionBias = priceChangePercent >= 0 ? 1.05 : 0.97;
      const score = (volatilityScore + spikeScore + imbalanceScore) * volumeBoost * directionBias;

      ranked.push({
        symbol,
        quoteAsset: matchingQuote,
        priceChangePercent,
        lastPrice,
        quoteVolume,
        baseVolume,
        volatilityPct: rangePct,
        spikeScore,
        score,
        direction: priceChangePercent >= 0 ? 'up' : 'down',
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }
}
