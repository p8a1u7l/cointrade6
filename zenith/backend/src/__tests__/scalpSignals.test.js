import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const distPath = path.resolve(repoRoot, 'dist/packages/signals/src/index.js');

function freshQuery() {
  return `?ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function removeDist() {
  fs.rmSync(path.dirname(distPath), { recursive: true, force: true });
}

// The scalping signals loader should transparently bundle the TypeScript sources
// when a prebuilt dist artifact is unavailable.
test('scalping signals module loads via bundled fallback', async () => {
  removeDist();
  const module = await import(`../services/scalpSignals.js${freshQuery()}`);
  module.__resetScalpSignalsLoaderForTests();
  assert.equal(typeof module.updateScalpInterest, 'function');

  try {
    await assert.doesNotReject(async () => {
      await module.updateScalpInterest([
        { symbol: 'BTCUSDT', tradingSymbol: 'BTCUSDT', score: 4.2, updatedAt: Date.now() },
      ]);
    });
  } finally {
    module.__resetScalpSignalsLoaderForTests();
    removeDist();
  }
});

test('scalping signals module compiles via TypeScript fallback when bundling is unavailable', async () => {
  removeDist();
  process.env.SCALP_SIGNALS_DISABLE_ESBUILD = '1';

  const module = await import(`../services/scalpSignals.js${freshQuery()}`);
  module.__resetScalpSignalsLoaderForTests();

  let invoked = 0;
  module.__setScalpSignalsTestOverrides({
    runTscBuild: () => {
      invoked += 1;
      fs.mkdirSync(path.dirname(distPath), { recursive: true });
      fs.writeFileSync(
        distPath,
        [
          'exports.loop = async function loop() { return null; };',
          'exports.getRealizedPnl = function getRealizedPnl() { return 0; };',
          'exports.updateInterestHotlist = function updateInterestHotlist() {};',
        ].join('\n')
      );
    },
  });

  try {
    await assert.doesNotReject(async () => {
      await module.updateScalpInterest([
        { symbol: 'ETHUSDT', tradingSymbol: 'ETHUSDT', score: 3.1, updatedAt: Date.now() },
      ]);
    });

    assert.equal(invoked, 1);
  } finally {
    module.__resetScalpSignalsLoaderForTests();
    module.__setScalpSignalsTestOverrides();
    delete process.env.SCALP_SIGNALS_DISABLE_ESBUILD;
    removeDist();
  }
});
