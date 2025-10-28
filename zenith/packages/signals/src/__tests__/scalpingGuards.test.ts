import { test } from "node:test";
import assert from "node:assert/strict";
import cfg from "@repo/core/config";
import { computeSignalFreshSec, shouldForceFlat, CooldownTracker } from "../scalpGuards";
import { microFiltersOk } from "../quality";
import { NswOut } from "../types";

test("signal older than stale limit is rejected", () => {
  const now = Date.now();
  const signalTs = now - 11_000;
  const age = computeSignalFreshSec(signalTs, now);
  assert.ok(age > (cfg.scalp?.signalStaleSec ?? 10));
});

test("micro filters block spreads or latency above caps", () => {
  const nsw: NswOut = {
    aggImpact: 0.1,
    grade: "Notice",
    policy: { sizeMul: 1, forbidMarket: false, modelPref: "BREAKOUT", spreadCapBp: 2 },
  };
  const ok = microFiltersOk({
    side: "LONG",
    spreadBp: 2.1,
    expectedSlipBp: 2.4,
    latencyMs: 90,
    quoteAgeMs: 100,
    depthBias: 0.95,
    nsw,
  });
  assert.strictEqual(ok, false);
});

test("forcing flat after hold/bars limit", () => {
  const forcedByTime = shouldForceFlat({ holdSec: 151, barsHeld: 1 });
  const forcedByBars = shouldForceFlat({ holdSec: 20, barsHeld: (cfg.scalp?.maxBars ?? 3) });
  assert.ok(forcedByTime);
  assert.ok(forcedByBars);
});

test("cooldown engages after consecutive stops", () => {
  const tracker = new CooldownTracker();
  const now = Date.now();
  tracker.register("BTCUSDT", "stop", now);
  tracker.register("BTCUSDT", "stop", now + 1_000);
  assert.ok(tracker.isBlocked("BTCUSDT", now + 2_000));
  const afterCooldown = now + (cfg.scalp?.cooldownMs ?? 60_000) + 65_000;
  assert.ok(!tracker.isBlocked("BTCUSDT", afterCooldown));
});
