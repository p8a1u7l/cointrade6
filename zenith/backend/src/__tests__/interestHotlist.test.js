import assert from 'node:assert/strict';
import test from 'node:test';

let getInterestHotlist;
let __resetInterestHotlistCacheForTests;
let __setTrendingProviderForTests;
let __resetTrendingCacheForTests;
let normalizeTrendingHotlistPayload;
let normalizeTrendingMovers;
let modulesReady = false;

async function ensureModules() {
  if (modulesReady) {
    return;
  }
  process.env.BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? 'test-key';
  process.env.BINANCE_API_SECRET = process.env.BINANCE_API_SECRET ?? 'test-secret';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'sk-test';
  process.env.BINANCE_SYMBOLS = process.env.BINANCE_SYMBOLS ?? 'BTCUSDT,ETHUSDT';

  const hotlistModule = await import('../services/interestHotlist.js');
  getInterestHotlist = hotlistModule.getInterestHotlist;
  __resetInterestHotlistCacheForTests = hotlistModule.__resetInterestHotlistCacheForTests;
  normalizeTrendingHotlistPayload = hotlistModule.normalizeTrendingHotlistPayload;

  const trendingModule = await import('../services/trendingSymbols.js');
  __setTrendingProviderForTests = trendingModule.__setTrendingProviderForTests;
  __resetTrendingCacheForTests = trendingModule.__resetTrendingCacheForTests;
  normalizeTrendingMovers = trendingModule.normalizeTrendingMovers;

  modulesReady = true;
}

const SAMPLE_TREND_ENTRY = {
  symbol: 'BTC',
  tradingSymbol: 'BTCUSDT',
  score: 4.2,
  changePct24h: 6.5,
  quoteVolume24h: 250000000,
  reasons: ['24h change +6.50%', 'Quote volume 250.00M'],
};

const SAMPLE_MOVER = {
  symbol: 'ETHUSDT',
  quoteAsset: 'USDT',
  priceChangePercent: '5.1',
  quoteVolume: '240000000',
};

test.beforeEach(async () => {
  await ensureModules();
  __resetInterestHotlistCacheForTests();
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

test('normalizeTrendingHotlistPayload maps trending fields', async () => {
  await ensureModules();
  const payload = normalizeTrendingHotlistPayload({ entries: [SAMPLE_TREND_ENTRY], updatedAt: 123 });
  assert.equal(payload.updatedAt, 123);
  assert.equal(payload.entries.length, 1);
  const entry = payload.entries[0];
  assert.equal(entry.tradingSymbol, 'BTCUSDT');
  assert.equal(entry.symbol, 'BTC');
  assert.equal(entry.score, 4.2);
  assert.equal(entry.metrics.changePct24h, 6.5);
  assert.equal(entry.metrics.quoteVolume24h, 250000000);
  assert.deepEqual(entry.reasons, SAMPLE_TREND_ENTRY.reasons);
});

test('getInterestHotlist returns cached payload without repeated fetches', async () => {
  await ensureModules();
  const counter = { count: 0 };
  __setTrendingProviderForTests(mockTrendingProvider([SAMPLE_MOVER], counter));

  const firstTrending = normalizeTrendingMovers([SAMPLE_MOVER]);
  assert.equal(firstTrending.entries[0].tradingSymbol, 'ETHUSDT');

  const first = await getInterestHotlist({ force: true });
  assert.equal(counter.count, 1);
  assert.equal(first.entries[0].tradingSymbol, 'ETHUSDT');

  const second = await getInterestHotlist();
  assert.equal(counter.count, 1);
  assert.equal(second.entries[0].tradingSymbol, 'ETHUSDT');
});

test('getInterestHotlist falls back to cached payload on failure', async () => {
  await ensureModules();
  const counter = { count: 0 };
  __setTrendingProviderForTests(mockTrendingProvider([SAMPLE_MOVER], counter));

  const initial = await getInterestHotlist({ force: true });
  assert.equal(counter.count, 1);
  assert.ok(initial.entries.length > 0);

  __setTrendingProviderForTests(mockTrendingProvider(new Error('binance down')));
  const fallback = await getInterestHotlist({ force: true });
  assert.equal(fallback.entries.length, initial.entries.length);
});

test('getInterestHotlist returns empty payload when provider fails and no cache exists', async () => {
  await ensureModules();
  __setTrendingProviderForTests(mockTrendingProvider(new Error('binance down')));

  const result = await getInterestHotlist({ force: true });
  assert.equal(result.entries.length, 0);
  assert.equal(result.totals.length, 0);
  assert.ok(result.updatedAt >= 0);
});
