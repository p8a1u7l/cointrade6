import test from "node:test";
import assert from "node:assert/strict";
import { getFeatures } from "../features";
import type { Features } from "@repo/core/schemas";
import { callDl } from "@repo/models-dl/client";
import { callNSW } from "@repo/models-llm/nsw";

function createResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("getFeatures falls back to synthetic data when feature service fails", async () => {
  const originalFetch = global.fetch;
  let step = 0;
  const klines = Array.from({ length: 10 }).map((_, index) => {
    const base = 30_000 + index * 50;
    const ts = Date.now() - (10 - index) * 60_000;
    return [
      ts,
      base,
      base + 40,
      base - 40,
      base + 10,
      500 + index,
      ts + 60_000,
      1_000 + index * 10,
      20,
      100,
      200,
      0,
    ];
  });
  const depth = { bids: [["30000", "12"], ["29999", "8"]], asks: [["30010", "15"], ["30011", "6"]] };
  const ticker = { volume: "1200", quoteVolume: "36000000" };
  const exchangeInfo = {
    symbols: [
      {
        symbol: "BTCUSDT",
        filters: [{ filterType: "PRICE_FILTER", tickSize: "0.1" }],
      },
    ],
  };

  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    step += 1;
    if (step === 1) {
      return new Response("service down", { status: 503, statusText: "down" });
    }
    if (url.includes("klines")) {
      return createResponse(klines);
    }
    if (url.includes("depth")) {
      return createResponse(depth);
    }
    if (url.includes("ticker/24hr")) {
      return createResponse(ticker);
    }
    if (url.includes("exchangeInfo")) {
      return createResponse(exchangeInfo);
    }
    throw new Error(`Unexpected fetch url ${url}`);
  }) as typeof global.fetch;

  try {
    const snapshot = await getFeatures("BTCUSDT");
    assert.equal(snapshot.symbol, "BTCUSDT");
    assert.equal(snapshot.candles.length, 10);
    assert.ok(Number.isFinite(snapshot.ema25));
    assert.equal(typeof snapshot.liveLast, "function");
  } finally {
    global.fetch = originalFetch;
  }
});

function buildFeatureFixture(): Features {
  const now = Date.now();
  const candles = Array.from({ length: 30 }).map((_, index) => {
    const base = 20_000 + index * 10;
    const ts = now - (30 - index) * 60_000;
    return {
      ts,
      open: base,
      high: base + 20,
      low: base - 20,
      close: base + 5,
      volume: 300 + index,
    };
  });
  return {
    ts: now,
    symbol: "ETHUSDT",
    candles,
    ema25: 20_150,
    ema50: 20_120,
    ema100: 20_000,
    rsi14: 58,
    atr22: 120,
    vp: { vah: 20_400, val: 19_900, poc: 20_150 },
    fvg: [],
    fvgAvgSize: 60,
    orderflow: { buy: 1500, sell: 900, bubble: false },
    micro: { spreadBp: 1.2, latencyMs: 80, quoteAgeMs: 60, bidQty10: 200, askQty10: 180 },
    close: candles.at(-1)!.close,
    tickSize: 0.1,
    availableUSDT: 5_000,
    session: "LONDON",
    regime: "BULLISH",
    candleAgeSec: 45,
    signalAgeSec: 30,
    trades: [],
  };
}

test("callDl returns heuristic output when service fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("dl offline");
  }) as typeof global.fetch;

  try {
    const result = await callDl("ETHUSDT", buildFeatureFixture());
    assert.ok(result.q >= 0 && result.q <= 1);
    assert.ok(result.up >= 0 && result.down >= 0);
    assert.ok(result.slipBp >= 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callNSW returns heuristic policy when service fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("nsw offline");
  }) as typeof global.fetch;

  try {
    const result = await callNSW("BTCUSDT");
    assert.ok(result.aggImpact >= 0);
    assert.ok(["None", "Notice", "High"].includes(result.grade));
    assert.equal(typeof result.policy.sizeMul, "number");
  } finally {
    global.fetch = originalFetch;
  }
});
