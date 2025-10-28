import { Candidate } from "@repo/packages/signals/src/types";
import { Features } from "@repo/core/schemas";
import cfg from "@repo/core/config";

export type ExitPlan = {
  sl: number;
  tp1?: number;
  tp2?: number;
  trail: {
    mode: "prev_candle";
    atrMult: number;
    moveToBEOnTP1: boolean;
  };
  maxHoldSec: number;
  maxBars: number;
};

export function buildExitPlan(side:"LONG"|"SHORT", entry:number, c: Candidate, f: Features): ExitPlan {
  const atr = f.atr22;
  const tick = f.tickSize;
  const atrTicks = Math.max(2, Math.round((atr * 0.6) / tick));
  const hinted = Math.max(c.stopHint.distanceTick, atrTicks);
  const dist = hinted * tick;

  const sl = side==="LONG" ? entry - dist : entry + dist;

  const rr1 = c.tpPlan.tp1RR ?? cfg.rrTargets.model1[0] ?? 1.6;
  const rr2 = c.tpPlan.tp2RR;

  const risk = Math.abs(entry - sl);
  const tp1 = risk > 0 ? (side==="LONG" ? entry + risk*rr1 : entry - risk*rr1) : undefined;
  const tp2 = rr2 && risk > 0 ? (side==="LONG" ? entry + risk*rr2 : entry - risk*rr2) : undefined;

  return {
    sl,
    tp1,
    tp2,
    trail: { mode: "prev_candle", atrMult: 0, moveToBEOnTP1: true },
    maxHoldSec: cfg.scalp?.maxHoldSec ?? 150,
    maxBars: cfg.scalp?.maxBars ?? 3,
  };
}

export function updateStops(params:{
  side:"LONG"|"SHORT",
  entry:number,
  currentSL:number,
  lastClose:number,
  lastHigh:number,
  lastLow:number,
  atr:number,
  hitTP1:boolean
}): number {
  let { side, entry, currentSL, lastHigh, lastLow, hitTP1 } = params;
  if (hitTP1 && ((side==="LONG" && currentSL<entry) || (side==="SHORT" && currentSL>entry))) {
    currentSL = entry;
  }
  if (side === "LONG") {
    const candidate = Math.min(lastLow, entry);
    currentSL = Math.max(currentSL, candidate);
  } else {
    const candidate = Math.max(lastHigh, entry);
    currentSL = Math.min(currentSL, candidate);
  }
  return currentSL;
}
