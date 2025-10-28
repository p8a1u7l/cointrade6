import assert from 'node:assert/strict';
import test from 'node:test';

import { alignInterestEntries } from '../services/interestSymbolResolver.js';

const baseExchangeInfo = {
  bySymbol: new Map([
    [
      'BTCUSDT',
      {
        status: 'TRADING',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        permissions: ['USDTMarginedFutures'],
        raw: { baseAsset: 'BTC', quoteAsset: 'USDT' },
      },
    ],
    [
      'BTCBUSD',
      {
        status: 'TRADING',
        contractType: 'PERPETUAL',
        quoteAsset: 'BUSD',
        permissions: ['USDTMarginedFutures'],
        raw: { baseAsset: 'BTC', quoteAsset: 'BUSD' },
      },
    ],
    [
      'ETHUSDT',
      {
        status: 'TRADING',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        permissions: ['FUTURE'],
        raw: { baseAsset: 'ETH', quoteAsset: 'USDT' },
      },
    ],
    [
      'ETHBUSD',
      {
        status: 'TRADING',
        contractType: 'PERPETUAL',
        quoteAsset: 'BUSD',
        permissions: ['TRD_GRP_005'],
        raw: { baseAsset: 'ETH', quoteAsset: 'BUSD' },
      },
    ],
    [
      'BADUSDT',
      {
        status: 'PENDING_TRADING',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        permissions: ['USDTMarginedFutures'],
        raw: { baseAsset: 'BAD', quoteAsset: 'USDT' },
      },
    ],
  ]),
};

test('alignInterestEntries resolves base-only symbols to tradable pairs', () => {
  const entries = [
    { symbol: 'btc', score: 2.4, z: 2.4, updatedAt: 1 },
    { symbol: 'BTC', score: 3.1, z: 3.1, updatedAt: 2 },
  ];
  const result = alignInterestEntries(entries, baseExchangeInfo, ['USDT']);
  assert.equal(result.length, 1);
  assert.equal(result[0].tradingSymbol, 'BTCUSDT');
  assert.equal(result[0].symbol, 'BTC');
  assert.equal(result[0].score, 3.1);
});

test('alignInterestEntries keeps valid trading symbols intact', () => {
  const entries = [
    { symbol: 'eth', tradingSymbol: 'ETHUSDT', score: 1.8, z: 1.9, updatedAt: 10 },
  ];
  const result = alignInterestEntries(entries, baseExchangeInfo, ['USDT']);
  assert.equal(result.length, 1);
  assert.equal(result[0].tradingSymbol, 'ETHUSDT');
  assert.equal(result[0].score, 1.8);
  assert.equal(result[0].symbol, 'ETH');
});

test('alignInterestEntries discards symbols without a tradable pair and notifies callback', () => {
  let discarded = 0;
  const entries = [
    { symbol: 'bad', score: 5 },
    { symbol: 'ghost', score: 6 },
  ];
  const result = alignInterestEntries(entries, baseExchangeInfo, ['USDT'], {
    onDiscard: () => {
      discarded += 1;
    },
  });
  assert.equal(result.length, 0);
  assert.equal(discarded, 2);
});

test('alignInterestEntries respects quote priority ordering', () => {
  const entries = [
    { symbol: 'eth', score: 2.1, z: 2.1 },
  ];
  const result = alignInterestEntries(entries, baseExchangeInfo, ['BUSD', 'USDT']);
  assert.equal(result.length, 1);
  assert.equal(result[0].tradingSymbol, 'ETHBUSD');
});

test('alignInterestEntries falls back to default quote order when none provided', () => {
  const entries = [
    { symbol: 'eth', score: 2.1, z: 2.1 },
  ];
  const result = alignInterestEntries(entries, baseExchangeInfo, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].tradingSymbol, 'ETHUSDT');
});
