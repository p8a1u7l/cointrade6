import { buildCandidates } from "@repo/packages/signals/src/buildCandidates";
import { decideWithPolicy } from "./mergePolicy";
import { buildExitPlan, updateStops, type ExitPlan } from "@repo/risk/plan";
import { closePosition, routeOrder } from "@repo/executor/router";
import { callDl } from "@repo/models-dl/client";
import { callNSW } from "@repo/models-llm/nsw";
import { getFeatures, type FeatureSnapshot } from "./features";
import cfg from "@repo/core/config";
import { IExchange } from "@repo/exchange-binance";
import { computeSignalFreshSec, CooldownTracker, shouldForceFlat } from "./scalpGuards";
import { strategyQualityThreshold } from "./quality";

const SLIP_CAP = cfg.scalp?.slippageBpCap ?? cfg.microFilters.slippageBp;

type Side = "LONG" | "SHORT";

type CloseReason = "STOP" | "TARGET" | "TIME";

type InterestEntry = {
  symbol: string;
  tradingSymbol?: string;
  score: number;
  z?: number;
  updatedAt: number;
};

const interestHot = new Map<string, InterestEntry>();

export function updateInterestHotlist(entries: InterestEntry[]): void {
  interestHot.clear();
  if (!Array.isArray(entries)) {
    return;
  }
  for (const raw of entries) {
    const score = Number(raw?.score);
    if (!Number.isFinite(score)) {
      continue;
    }
    const updatedAt = Number(raw?.updatedAt ?? Date.now());
    const base = typeof raw?.symbol === "string" ? raw.symbol.toUpperCase() : undefined;
    const trading = typeof raw?.tradingSymbol === "string" ? raw.tradingSymbol.toUpperCase() : undefined;
    const z = Number.isFinite(Number(raw?.z)) ? Number(raw?.z) : score;
    const normalized: InterestEntry = {
      symbol: base ?? trading ?? "",
      tradingSymbol: trading,
      score,
      z,
      updatedAt,
    };
    if (!normalized.symbol) {
      continue;
    }
    interestHot.set(normalized.symbol, normalized);
    if (trading && trading !== normalized.symbol) {
      interestHot.set(trading, normalized);
    }
  }
}

function resolveInterestEntry(symbol: string): InterestEntry | undefined {
  if (!symbol) {
    return undefined;
  }
  const direct = interestHot.get(symbol.toUpperCase());
  if (direct) {
    return direct;
  }
  const stripped = symbol.toUpperCase().replace(/(USDT|USDC|USD)$/i, "");
  return interestHot.get(stripped);
}

interface ActivePosition {
  side: Side;
  qty: number;
  entryPrice: number;
  plan: ExitPlan;
  hitTP1: boolean;
  enterTs: number;
  firstFillTs: number;
  entryBarTs: number;
  barsHeld: number;
  signalFreshSec: number;
  microOk: boolean;
}

const POSITION_EPSILON = 1e-6;

const activePositions = new Map<string, ActivePosition>();
const realizedLedger = new Map<string, number>();
const cooldowns = new CooldownTracker();

function recordRealized(symbol: string, delta: number): void {
  const current = realizedLedger.get(symbol) ?? 0;
  realizedLedger.set(symbol, current + delta);
}

function computeRealizedPnl(position: ActivePosition, exitPrice: number, quantity: number): number {
  const entry = position.entryPrice;
  const delta = position.side === "LONG" ? exitPrice - entry : entry - exitPrice;
  return delta * quantity;
}

function pickEntryPrice(repPrice: number | undefined, fallback: number): number {
  if (Number.isFinite(repPrice) && repPrice && repPrice > 0) {
    return repPrice;
  }
  return fallback;
}

async function closeAtPrice(
  ex: IExchange,
  symbol: string,
  position: ActivePosition,
  quantity: number,
  orderPrice: number,
  priceHint: number,
  reason: CloseReason
): Promise<{ realized: number; filled: number } | null> {
  if (!Number.isFinite(quantity) || quantity <= POSITION_EPSILON) {
    return null;
  }
  const orderSide = position.side === "LONG" ? "SELL" : "BUY";
  const price = Number.isFinite(orderPrice) && orderPrice > 0 ? orderPrice : priceHint;
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  const report = await closePosition(ex, { symbol, side: orderSide, qty: quantity, price });
  if (!report.accepted) {
    if (report.reason === "slippage above cap") {
      cooldowns.register(symbol, "slip");
    }
    return null;
  }
  const filledQty = Number.isFinite(report.filledQty) && (report.filledQty ?? 0) > 0
    ? (report.filledQty as number)
    : quantity;
  const exitPrice = pickEntryPrice(report.avgPrice, priceHint ?? price);
  const realized = computeRealizedPnl(position, exitPrice, filledQty);
  recordRealized(symbol, realized);
  if (reason === "STOP") {
    cooldowns.register(symbol, "stop");
  }
  if (report.slipBp !== undefined && report.slipBp > SLIP_CAP) {
    cooldowns.register(symbol, "slip");
  }
  return { realized, filled: filledQty };
}

function stopTriggered(position: ActivePosition, last: ReturnType<FeatureSnapshot["liveLast"]>): boolean {
  if (position.side === "LONG") {
    return last.low <= position.plan.sl;
  }
  return last.high >= position.plan.sl;
}

function targetHit(position: ActivePosition, target: number | undefined, last: ReturnType<FeatureSnapshot["liveLast"]>): boolean {
  if (!Number.isFinite(target)) {
    return false;
  }
  if (position.side === "LONG") {
    return last.high >= (target as number);
  }
  return last.low <= (target as number);
}

function barsSinceEntry(snapshot: FeatureSnapshot, entryBarTs: number): number {
  return snapshot.candles.filter((c) => c.ts >= entryBarTs).length;
}

export function getRealizedPnl(symbol?: string): number | Map<string, number> {
  if (typeof symbol === "string") {
    return realizedLedger.get(symbol) ?? 0;
  }
  return new Map(realizedLedger);
}

export async function loop(ex: IExchange, symbol: string) {
  const snapshot: FeatureSnapshot = await getFeatures(symbol);
  const dl = await callDl(symbol, snapshot);
  const nsw = await callNSW(symbol);
  const interest = resolveInterestEntry(symbol);

  const last = snapshot.liveLast();
  const active = activePositions.get(symbol);

  if (active) {
    const updatedStop = updateStops({
      side: active.side,
      entry: active.entryPrice,
      currentSL: active.plan.sl,
      lastClose: last.close,
      lastHigh: last.high,
      lastLow: last.low,
      atr: snapshot.atr22,
      hitTP1: active.hitTP1,
    });
    active.plan.sl = updatedStop;

    const holdSec = (Date.now() - active.firstFillTs) / 1000;
    const totalBarsSinceEntry = barsSinceEntry(snapshot, active.entryBarTs);
    active.barsHeld = Math.max(0, totalBarsSinceEntry - 1);

    if (holdSec >= (cfg.scalp?.maxHoldSec ?? active.plan.maxHoldSec) - 30 && holdSec < active.plan.maxHoldSec) {
      console.warn(`[scalp] ${symbol} holdSec=${holdSec.toFixed(1)} nearing cap ${active.plan.maxHoldSec}`);
    }

    if (shouldForceFlat({ holdSec, barsHeld: active.barsHeld, maxHoldSec: active.plan.maxHoldSec, maxBars: active.plan.maxBars })) {
      const priceHint = active.side === "LONG" ? last.close : last.close;
      const result = await closeAtPrice(ex, symbol, active, active.qty, last.close, priceHint, "TIME");
      if (result) {
        activePositions.delete(symbol);
      }
      return;
    }

    if (stopTriggered(active, last)) {
      const stopPrice = active.plan.sl;
      const priceHint = Number.isFinite(stopPrice) ? stopPrice : last.close;
      const result = await closeAtPrice(ex, symbol, active, active.qty, stopPrice, priceHint, "STOP");
      if (result) {
        activePositions.delete(symbol);
      }
      return;
    }

    const tp1Reached = !active.hitTP1 && active.plan.tp1 && targetHit(active, active.plan.tp1, last);
    if (tp1Reached) {
      const partialQty = Math.max(1, Math.floor(active.qty / 2));
      const tp1Price = active.plan.tp1 as number;
      const result = await closeAtPrice(ex, symbol, active, partialQty, tp1Price, tp1Price, "TARGET");
      if (result) {
        active.qty = Math.max(0, active.qty - result.filled);
        active.hitTP1 = true;
        active.plan.sl = Math.max(active.plan.sl, active.entryPrice);
      }
    }

    const tp2Target = active.plan.tp2 ?? active.plan.tp1;
    if (targetHit(active, tp2Target, last)) {
      const targetPrice = tp2Target ?? last.close;
      const result = await closeAtPrice(ex, symbol, active, active.qty, targetPrice, targetPrice ?? last.close, "TARGET");
      if (result) {
        activePositions.delete(symbol);
      }
      return;
    }

    if (active.qty <= POSITION_EPSILON) {
      activePositions.delete(symbol);
    }
    return;
  }

  if (cooldowns.isBlocked(symbol)) {
    return;
  }

  const candidates = buildCandidates(snapshot, dl, nsw, { interest });
  const decision = await decideWithPolicy({ features: snapshot, dl, nsw, candidates });

  const best = decision.candidates.find((c) => {
    if (c.signal === "NONE") return false;
    const threshold = strategyQualityThreshold(c.model);
    return c.quality >= threshold;
  });
  if (!best) return;

  const side: Side = best.signal === "LONG" ? "LONG" : "SHORT";
  const orderSide = side === "LONG" ? "BUY" : "SELL";
  const qty = Math.max(1, Math.floor((snapshot.availableUSDT * (dl.sizeMul ?? 1)) / snapshot.close));
  const entryRef = snapshot.close;
  const plan = buildExitPlan(side, entryRef, best, snapshot);

  const forbidMkt = nsw.policy.forbidMarket;
  const limitPx = orderSide === "BUY" ? entryRef - snapshot.tickSize : entryRef + snapshot.tickSize;
  const signalAgeSec = snapshot.signalAgeSec ?? snapshot.candleAgeSec ?? computeSignalFreshSec(snapshot.ts);

  const report = await routeOrder(ex, {
    symbol,
    side: orderSide,
    qty,
    limitPrice: limitPx,
    maxReprices: cfg.scalp?.repriceAttempts ?? 3,
    forbidMarket: forbidMkt,
    signalAgeSec,
    micro: {
      spreadBp: snapshot.micro.spreadBp,
      expectedSlipBp: dl.slipBp ?? snapshot.micro.spreadBp * 0.6,
      latencyMs: snapshot.micro.latencyMs,
      quoteAgeMs: snapshot.micro.quoteAgeMs,
      depthBias: side === "LONG"
        ? snapshot.micro.bidQty10 / Math.max(1, snapshot.micro.askQty10)
        : Math.max(1, snapshot.micro.askQty10) / Math.max(1, snapshot.micro.bidQty10),
    },
  });

  if (!report.accepted) {
    if (report.reason === "slippage above cap") {
      cooldowns.register(symbol, "slip");
    }
    return;
  }

  const filledQty = Number.isFinite(report.filledQty) && (report.filledQty ?? 0) > 0
    ? (report.filledQty as number)
    : qty;
  const entryPrice = pickEntryPrice(report.avgPrice, entryRef);
  activePositions.set(symbol, {
    side,
    qty: filledQty,
    entryPrice,
    plan,
    hitTP1: false,
    enterTs: Date.now(),
    firstFillTs: Date.now(),
    entryBarTs: snapshot.candles.at(-1)?.ts ?? snapshot.ts,
    barsHeld: 0,
    signalFreshSec: signalAgeSec,
    microOk: true,
  });

  if (report.slipBp !== undefined && report.slipBp > SLIP_CAP) {
    cooldowns.register(symbol, "slip");
  }
}
