import assert from 'node:assert/strict';
import test from 'node:test';

let fetchTrendingSymbols;
let __setTrendingProviderForTests;
let __resetTrendingCacheForTests;
let TradingEngine;
let modulesLoaded = false;

async function ensureModules() {
  if (modulesLoaded) {
    return;
  }
  process.env.BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? 'test-key';
  process.env.BINANCE_API_SECRET = process.env.BINANCE_API_SECRET ?? 'test-secret';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'sk-test';
  process.env.BINANCE_SYMBOLS = process.env.BINANCE_SYMBOLS ?? 'BTCUSDT,ETHUSDT';

  const trendingModule = await import('../services/trendingSymbols.js');
  fetchTrendingSymbols = trendingModule.fetchTrendingSymbols;
  __setTrendingProviderForTests = trendingModule.__setTrendingProviderForTests;
  __resetTrendingCacheForTests = trendingModule.__resetTrendingCacheForTests;

  ({ TradingEngine } = await import('../services/tradingEngine.js'));
  modulesLoaded = true;
}

const SAMPLE_MOVER = {
  symbol: 'BTCUSDT',
  quoteAsset: 'USDT',
  priceChangePercent: '4.2',
  quoteVolume: '123456789',
};

const SAMPLE_EXCHANGE_INFO = new Map([
  [
    'BTCUSDT',
    {
      status: 'TRADING',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      permissions: ['USDTMARGINEDFUTURES'],
    },
  ],
  [
    'ETHUSDT',
    {
      status: 'TRADING',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      permissions: ['USDTMARGINEDFUTURES'],
    },
  ],
]);

test.afterEach(async () => {
  await ensureModules();
  __resetTrendingCacheForTests();
});

function mockTrendingProvider(response, counter) {
  return async () => {
    if (counter) {
      counter.count += 1;
    }
    if (response instanceof Error) {
      throw response;
    }
    return Array.isArray(response) ? response : [response];
  };
}

test('fetchTrendingSymbols builds entries and caches results', async () => {
  await ensureModules();
  const counter = { count: 0 };
  __setTrendingProviderForTests(
    mockTrendingProvider([SAMPLE_MOVER, { ...SAMPLE_MOVER, symbol: 'ETHUSDT' }], counter),
  );

  const first = await fetchTrendingSymbols({ force: true });
  assert.equal(counter.count, 1);
  assert.ok(Array.isArray(first.entries));
  assert.ok(first.entries.length >= 1);
  const second = await fetchTrendingSymbols();
  assert.equal(counter.count, 1);
  assert.deepEqual(
    second.entries.map((entry) => entry.tradingSymbol),
    first.entries.map((entry) => entry.tradingSymbol),
  );
});

test('trading engine forwards trending symbols to the scalping module', async () => {
  await ensureModules();
  __setTrendingProviderForTests(mockTrendingProvider([{ ...SAMPLE_MOVER, symbol: 'ETHUSDT' }]));

  const engine = new TradingEngine(['BTCUSDT']);
  engine.binance.loadExchangeInfo = async () => SAMPLE_EXCHANGE_INFO;
  const interestCalls = [];
  engine._updateScalpInterest = async (entries) => {
    interestCalls.push(entries);
  };

  await engine.refreshTrendingSymbols(true);

  assert.equal(interestCalls.length, 1);
  const forwarded = interestCalls[0];
  assert.ok(Array.isArray(forwarded));
  assert.equal(forwarded[0].tradingSymbol, 'ETHUSDT');
});

test('trading engine retains last successful trends when provider fails', async () => {
  await ensureModules();
  __setTrendingProviderForTests(mockTrendingProvider([{ ...SAMPLE_MOVER, symbol: 'ETHUSDT' }]));

  const engine = new TradingEngine(['BTCUSDT']);
  engine.binance.loadExchangeInfo = async () => SAMPLE_EXCHANGE_INFO;
  engine._updateScalpInterest = async () => {};

  const initial = await engine.refreshTrendingSymbols(true);
  assert.equal(initial.entries.length, 1);

  engine._getTrendingSymbols = async () => {
    throw new Error('binance unavailable');
  };
  const fallback = await engine.refreshTrendingSymbols(true);
  assert.equal(fallback.entries.length, 1);
});
