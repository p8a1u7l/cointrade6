import { Candle, Features } from "@repo/core/schemas";

export function bodySize(c: Candle): number {
  return Math.abs(c.close - c.open);
}
export function avgBody(cs: Candle[], n=20): number {
  const s = cs.slice(-n);
  return s.reduce((a,c)=>a+bodySize(c),0)/(s.length||1);
}
export function nearWithinAtr(price:number, level:number, atr:number, mult=0.5): boolean {
  return Math.abs(price-level) <= atr*mult;
}
export function lastSwing(features: Features, side:"LONG"|"SHORT"): number {
  // 단순 스윙: 최근 10봉 최고/최저
  const cs = features.candles.slice(-10);
  return side==="LONG" ? Math.min(...cs.map(c=>c.low)) : Math.max(...cs.map(c=>c.high));
}
export function distanceTicks(dist:number, tick:number): number {
  return Math.max(1, Math.round(dist / tick));
}
export function pickNearestEntryLevel(f: Features, fvg?:{from:number;to:number}){
  const candidates = [
    {k:"lvn", v: f.vp.lvn?.[0] ?? Number.NaN},
    {k:"vah", v: f.vp.vah},
    {k:"val", v: f.vp.val},
    {k:"ema25", v: f.ema25},
    {k:"ema50", v: f.ema50},
    ...(fvg?[{k:"fvg_edge", v:(fvg.from+fvg.to)/2} as any]:[])
  ].filter(x=>!Number.isNaN(x.v));
  let best = candidates[0] ?? {k:"ema50", v:f.ema50};
  for (const c of candidates) {
    if (Math.abs(f.close-c.v) < Math.abs(f.close-best.v)) best = c;
  }
  return best.k as "lvn"|"vah"|"val"|"ema25"|"ema50"|"fvg_edge";
}

export function retracedWithinBars(level:number, features: Features, bars=2): boolean {
  const recent = features.candles.slice(-Math.max(1, bars));
  return recent.some(c => c.low<=level && c.high>=level);
}

export function candleDistanceFrom(price:number, level:number, atr:number): number {
  if (atr <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(price - level) / atr;
}
