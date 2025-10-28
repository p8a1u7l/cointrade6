import { Features } from "@repo/core/schemas";
import { DlOut, NswOut, Candidate } from "./types";
import {
  avgBody,
  bodySize,
  distanceTicks,
  pickNearestEntryLevel,
  retracedWithinBars,
  candleDistanceFrom,
  lastSwing,
} from "./helpers";
import { calcQualityScore, microFiltersOk, strategyQualityThreshold } from "./quality";
import cfg from "@repo/core/config";
import { isEngulfing, isHammer, isShootingStar, isDoji, isTweezerTopBottom, isMarubozu } from "@repo/core/patterns";
import { computeSignalFreshSec } from "./scalpGuards";

type Side = "LONG"|"SHORT";

const LARGE_TRADE_ABS_THRESHOLD = 10;
const LARGE_TRADE_MULTIPLE = 2.5;

function patternCountAt(features: Features, idx: number, side: Side): {count:number, names:string[]} {
  const n:string[] = [];
  if (isEngulfing(features.candles, idx, side)) n.push(`${side}Engulfing`);
  if (isHammer(features.candles, idx) && side==="LONG") n.push("Hammer");
  if (isShootingStar(features.candles, idx) && side==="SHORT") n.push("ShootingStar");
  if (isDoji(features.candles, idx)) n.push("Doji");
  const tw = isTweezerTopBottom(features.candles, idx);
  if (tw) n.push(`Tweezer-${tw}`);
  if (isMarubozu(features.candles, idx, side)) n.push("Marubozu");
  return { count: n.length, names: n };
}

function rsiOk(features: Features, side: Side): boolean {
  return side === "LONG" ? features.rsi14 > 50 : features.rsi14 < 50;
}

function orderflowRatio(features: Features, side: Side): {ok:boolean, ratio:number, reason:string} {
  const of = features.orderflow;
  const ratio = side === "LONG" ? (of.buy / Math.max(1e-9, of.sell)) : (of.sell / Math.max(1e-9, of.buy));
  const ok = ratio >= (cfg.oflowRatioMin ?? 2.0) || of.bubble;
  return { ok, ratio, reason: `ofRatio=${ratio.toFixed(2)} bubble=${of.bubble}` };
}

function hasLargePrint(features: Features, side: Side, now: number): boolean {
  const trades = features.trades ?? [];
  if (trades.length === 0) {
    return features.orderflow.bubble;
  }
  const windowMs = 60_000;
  const dir = side === "LONG" ? "buy" : "sell";
  const recent = trades.filter((t) => now - t.ts <= windowMs && t.side === dir);
  if (recent.some((t) => t.qty >= LARGE_TRADE_ABS_THRESHOLD)) {
    return true;
  }
  if (recent.length === 0) {
    return features.orderflow.bubble;
  }
  const avg = recent.reduce((sum, t) => sum + t.qty, 0) / recent.length;
  return recent.some((t) => t.qty >= avg * LARGE_TRADE_MULTIPLE);
}

function fvgForSide(features: Features, side: Side): {ok:boolean, zone?:{from:number;to:number}, reason:string} {
  const fvg = features.fvg?.find(z => z.type === (side==="LONG"?"bullish":"bearish"));
  if (!fvg) return {ok:false, reason:"no FVG"};
  const avg = features.fvgAvgSize ?? 0;
  const ok = fvg.size >= avg * (cfg.fvgMinMultiple ?? 1.2);
  return { ok, zone: ok ? {from: fvg.from, to: fvg.to} : undefined, reason: ok?`fvgSize=${fvg.size.toFixed(2)} ok`: "fvg too small" };
}

function sessionBlocked(features: Features, nsw: NswOut): boolean {
  if ((features.session === "NY" || features.session === "BRIDGE") && (nsw.grade === "High" || nsw.grade === "Critical")) {
    return true;
  }
  return false;
}

function vpNear(features: Features, price: number): {ok:boolean, where:"vah"|"val"|"poc"|"na"} {
  const vp = features.vp;
  const atr = features.atr22;
  const near = (a:number,b:number)=> Math.abs(a-b) <= atr*0.5;
  if (near(price, vp.vah)) return {ok:true, where:"vah"};
  if (near(price, vp.val)) return {ok:true, where:"val"};
  if (near(price, vp.poc)) return {ok:true, where:"poc"};
  return {ok:false, where:"na"};
}

function regimeOk(features: Features, side: Side): boolean {
  const { ema25, ema50, ema100, close } = features;
  if (side==="LONG") return (ema25>ema50 && ema50>ema100 && close>ema25);
  return (ema25<ema50 && ema50<ema100 && close<ema25);
}

type InterestContext = { score?: number; z?: number; updatedAt: number };
type CandidateExtras = { interest?: InterestContext };

function formatNumber(value: number | undefined, digits = 2): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : "na";
}

export function buildCandidates(features: Features, dl: DlOut, nsw: NswOut, extras: CandidateExtras = {}): Candidate[] {
  const now = Date.now();
  const out: Candidate[] = [];
  const atr = features.atr22;
  const tick = features.tickSize;

  const spreadBp = features.micro.spreadBp;
  const latencyMs = features.micro.latencyMs;
  const quoteAgeMs = features.micro.quoteAgeMs;
  const depthBiasLong = features.micro.bidQty10 / Math.max(1, features.micro.askQty10);
  const depthBiasShort = Math.max(1, features.micro.askQty10) / Math.max(1, features.micro.bidQty10);

  const computedSignalSec = computeSignalFreshSec(features.ts, now);
  const signalFreshSec = features.signalAgeSec ?? features.candleAgeSec ?? computedSignalSec;
  const staleLimit = cfg.scalp?.signalStaleSec ?? 10;
  const signalFresh = signalFreshSec <= staleLimit;

  const sessionRestricted = sessionBlocked(features, nsw);

  const microBase = {
    spreadBp,
    latencyMs,
    quoteAgeMs,
  };

  const price = features.close;

  const interestCfg = cfg.scalp?.interest ?? {};
  const interest = extras.interest;
  const interestScore = Number.isFinite(interest?.score) ? (interest?.score as number) : undefined;
  const interestZ = Number.isFinite(interest?.z) ? (interest?.z as number) : interestScore;
  const interestAgeSec = interest ? Math.max(0, (Date.now() - interest.updatedAt) / 1000) : undefined;
  const interestFresh =
    interestAgeSec !== undefined && interestAgeSec <= (interestCfg.staleSec ?? 600);
  const boostEligible =
    interestFresh && interestScore !== undefined && interestScore >= (interestCfg.minScore ?? 2);
  const boost = boostEligible && interestZ !== undefined
    ? Math.min(0.08, interestZ * (interestCfg.boostPerZ ?? 0.02))
    : 0;
  const interestReason = interest
    ? `interest.z=${formatNumber(interestZ)} age=${
        interestAgeSec !== undefined ? Math.round(interestAgeSec) : "na"
      }s boost=${formatNumber(boost)}`
    : "interest=none";
  const applyInterest = (quality: number) => Math.min(1, quality + (boostEligible ? boost : 0));

  // ─────────────────────────────────────────
  // 전략 A: Breakout Momentum (Scalp)
  // ─────────────────────────────────────────
  for (const side of ["LONG","SHORT"] as const) {
    const rOk = regimeOk(features, side);
    const rsi = rsiOk(features, side);
    const of = orderflowRatio(features, side);
    const fvg = fvgForSide(features, side);
    const pc = patternCountAt(features, features.candles.length-1, side);
    const largePrint = hasLargePrint(features, side, now);
    const breakoutLevel = side === "LONG" ? features.vp.vah : features.vp.val;
    const c0 = features.candles.at(-1)!;
    const body = bodySize(c0);
    const ab20 = avgBody(features.candles, 20);
    const strongBreak = side === "LONG" ? (c0.close>breakoutLevel && body >= ab20*1.5) : (c0.close<breakoutLevel && body >= ab20*1.5);
    const retraceOk = retracedWithinBars(breakoutLevel, features, 2) ||
      retracedWithinBars(features.ema25, features, 2) ||
      retracedWithinBars(features.ema50, features, 3) ||
      (fvg.zone ? retracedWithinBars((fvg.zone.from+fvg.zone.to)/2, features, 3) : false);
    const distance = candleDistanceFrom(price, breakoutLevel, atr);
    const vpN = vpNear(features, price);

    if (rOk && rsi && strongBreak && of.ok && largePrint && retraceOk && pc.count >= 1 && distance <= 1) {
      let q = calcQualityScore({
        regimeOk: rOk,
        ofRatio: of.ratio,
        patternCount: pc.count,
        rsiOk: rsi,
        fvgOk: fvg.ok,
        vpNearOk: vpN.ok,
        ts: now,
        nsw,
      });
      q = Math.min(1, q);
      const quality = applyInterest(q);

      const expectedSlip = dl.slipBp ?? (spreadBp * 0.6);
      const microOk = !sessionRestricted && microFiltersOk({
        side,
        spreadBp,
        expectedSlipBp: expectedSlip,
        latencyMs,
        quoteAgeMs,
        depthBias: side==="LONG" ? depthBiasLong : depthBiasShort,
        nsw,
      });

      const threshold = strategyQualityThreshold("BREAKOUT");
      const entryHint = { level: pickNearestEntryLevel(features, fvg.zone) };
      const stopHint = { type: "swing" as const, distanceTick: Math.max(2, distanceTicks(atr*0.6, tick)) };
      const tpPlan = { tp1RR: cfg.rrTargets.model1[0] ?? 1.7, tp2RR: undefined, target: "next_va" as const };

      out.push({
        signal: microOk && signalFresh && quality >= threshold ? side : "NONE",
        model: "BREAKOUT",
        quality,
        entryHint,
        stopHint,
        tpPlan,
        micro: { spreadBp, latencyMs, quoteAgeMs, depthBias: side==="LONG"?depthBiasLong:depthBiasShort },
        reasons: [
          `regime=${rOk}`, `RSI=${features.rsi14.toFixed(1)}`,
          of.reason,
          fvg.reason,
          `patterns=${pc.names.join(",")||"none"}`,
          `retrace=${retraceOk}`,
          `signalFresh=${signalFreshSec.toFixed(1)}s`,
          `microOk=${microOk}`,
          `distanceATR=${distance.toFixed(2)}`,
          interestReason,
        ],
      });
    }
  }

  // ─────────────────────────────────────────
  // 전략 B: Mean Reversion Fakeout (Scalp)
  // ─────────────────────────────────────────
  const c0 = features.candles.at(-1)!; const c1 = features.candles.at(-2);
  const inVA = (x:number)=> x<=features.vp.vah && x>=features.vp.val;
  const leftVAUp   = !!(c1 && c1.high>features.vp.vah && inVA(c0.close));
  const leftVADown = !!(c1 && c1.low<features.vp.val && inVA(c0.close));
  const rsiMid = features.rsi14 >= 45 && features.rsi14 <= 55;

  if (rsiMid && (leftVAUp || leftVADown)) {
    const side: Side = leftVAUp ? "SHORT" : "LONG";
    const pc = patternCountAt(features, features.candles.length-1, side);
    const of = orderflowRatio(features, side);
    const fvg = fvgForSide(features, side);
    const vpN = vpNear(features, features.vp.poc);

    let q = calcQualityScore({
      regimeOk: true,
      ofRatio: of.ratio,
      patternCount: pc.count,
      rsiOk: true,
      fvgOk: fvg.ok,
      vpNearOk: vpN.ok,
      ts: now,
      nsw,
    });
    if (fvg.ok) {
      q = Math.min(1, q + 0.05);
    }
    const quality = applyInterest(q);

    const expectedSlip = dl.slipBp ?? (spreadBp * 0.6);
    const microOk = !sessionRestricted && microFiltersOk({
      side,
      spreadBp,
      expectedSlipBp: expectedSlip,
      latencyMs,
      quoteAgeMs,
      depthBias: side==="LONG" ? depthBiasLong : depthBiasShort,
      nsw,
    });

    const threshold = strategyQualityThreshold("MEAN");

    out.push({
      signal: microOk && signalFresh && quality >= threshold ? side : "NONE",
      model: "MEAN",
      quality,
      entryHint: { level: leftVAUp ? "vah" : "val" },
      stopHint: { type: "swing", distanceTick: Math.max(2, distanceTicks(atr*0.6, tick)) },
      tpPlan: { tp1RR: cfg.rrTargets.model2[0] ?? 1.55, tp2RR: undefined, target: "poc" },
      micro: { spreadBp, latencyMs, quoteAgeMs, depthBias: side==="LONG"?depthBiasLong:depthBiasShort },
      reasons: [
        `fakeout=${leftVAUp?"upper→in":"lower→in"}`,
        `RSI=${features.rsi14.toFixed(1)}`,
        of.reason,
        fvg.reason,
        `patterns=${pc.names.join(",")||"none"}`,
        `signalFresh=${signalFreshSec.toFixed(1)}s`,
        `microOk=${microOk}`,
        interestReason,
      ]
    });
  }

  // ─────────────────────────────────────────
  // 전략 C: EMA50 Retest (Scalp)
  // ─────────────────────────────────────────
  const body = bodySize(c0);
  const ab20 = avgBody(features.candles, 20);
  const crossedUp   = c0.close>features.ema50 && c0.open<features.ema50 && body >= ab20*1.0;
  const crossedDown = c0.close<features.ema50 && c0.open>features.ema50 && body >= ab20*1.0;
  const didRetrace = retracedWithinBars(features.ema50, features, 3);
  if ((crossedUp||crossedDown) && didRetrace) {
    const side: Side = crossedUp ? "LONG" : "SHORT";
    const rOk = true;
    const of = orderflowRatio(features, side);
    const rsi = rsiOk(features, side);
    const pc = patternCountAt(features, features.candles.length-1, side);
    const fvg = fvgForSide(features, side);
    const vpN = vpNear(features, price);
    const swingLevel = lastSwing(features, crossedUp ? "SHORT" : "LONG");
    const swingBreak = crossedUp ? price > swingLevel : price < swingLevel;

    if (rsi && swingBreak) {
      let q = calcQualityScore({
        regimeOk: rOk,
        ofRatio: of.ratio,
        patternCount: pc.count,
        rsiOk: rsi,
        fvgOk: fvg.ok,
        vpNearOk: vpN.ok,
        ts: now,
        nsw,
      });
      q = Math.min(1, q);

      const expectedSlip = dl.slipBp ?? (spreadBp * 0.6);
      const microOk = !sessionRestricted && microFiltersOk({
        side,
        spreadBp,
        expectedSlipBp: expectedSlip,
        latencyMs,
        quoteAgeMs,
        depthBias: side==="LONG" ? depthBiasLong : depthBiasShort,
        nsw,
      });

      const threshold = strategyQualityThreshold("EMA50");

      const quality = applyInterest(q);

      out.push({
        signal: microOk && signalFresh && quality >= threshold ? side : "NONE",
        model: "EMA50",
        quality,
        entryHint: { level: "ema50" },
        stopHint: { type: "swing", distanceTick: Math.max(2, distanceTicks(atr*0.6, tick)) },
        tpPlan: { tp1RR: cfg.rrTargets.model3[0] ?? 1.65, tp2RR: undefined, target: "next_va" },
        micro: { spreadBp, latencyMs, quoteAgeMs, depthBias: side==="LONG"?depthBiasLong:depthBiasShort },
        reasons: [
          `cross50=${crossedUp?"up":"down"}`,
          `retrace=${didRetrace}`,
          of.reason,
          `RSI=${features.rsi14.toFixed(1)}`,
          fvg.reason,
          `swingBreak=${swingBreak}`,
          `signalFresh=${signalFreshSec.toFixed(1)}s`,
          `microOk=${microOk}`,
          interestReason,
        ]
      });
    }
  }

  if (out.length===0) {
    out.push({
      signal:"NONE", model:"NONE", quality:0,
      entryHint:{level:"ema50"}, stopHint:{type:"swing", distanceTick:0},
      tpPlan:{tp1RR:1, target:"na"},
      micro:{spreadBp, latencyMs, quoteAgeMs, depthBias:1},
      reasons:[sessionRestricted?"nsw restricted":"no candidate", interestReason],
    });
  }
  return out;
}
