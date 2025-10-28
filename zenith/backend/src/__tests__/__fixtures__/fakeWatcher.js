export const stats = { calls: 0 };

export function reset() {
  stats.calls = 0;
}

export async function runWatcher() {
  stats.calls += 1;
  const now = 1_700_000_000_000;
  return {
    now,
    hot: [
      {
        symbol: 'BTC',
        score: 3.2,
        z: 3.2,
        metrics: {
          count: 5,
          velocity: 0.5,
          diversity: 3,
          novelty: 0.7,
          momentum: 0.6,
        },
      },
      {
        symbol: 'DOGE',
        score: 1.2,
        z: 1.2,
        metrics: {
          count: 2,
          velocity: 0.2,
          diversity: 1,
          novelty: 0.3,
          momentum: 0.2,
        },
      },
    ],
    totals: [
      { symbol: 'BTC', mentions: 5 },
      { symbol: 'DOGE', mentions: 2 },
    ],
  };
}
