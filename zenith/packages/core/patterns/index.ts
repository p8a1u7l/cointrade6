import { Candle } from "@repo/core/schemas";

type Side = "LONG" | "SHORT";

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}

function range(c: Candle): number {
  return c.high - c.low;
}

function isBullish(c: Candle): boolean {
  return c.close >= c.open;
}

function isBearish(c: Candle): boolean {
  return c.close < c.open;
}

function upperShadow(c: Candle): number {
  return c.high - Math.max(c.open, c.close);
}

function lowerShadow(c: Candle): number {
  return Math.min(c.open, c.close) - c.low;
}

export function isEngulfing(candles: Candle[], idx: number, side: Side): boolean {
  const cur = candles[idx];
  const prev = candles[idx - 1];
  if (!cur || !prev) return false;

  if (side === "LONG") {
    return isBullish(cur) && isBearish(prev) && cur.open <= prev.close && cur.close >= prev.open && body(cur) >= body(prev);
  }
  return isBearish(cur) && isBullish(prev) && cur.open >= prev.close && cur.close <= prev.open && body(cur) >= body(prev);
}

export function isHammer(candles: Candle[], idx: number): boolean {
  const cur = candles[idx];
  if (!cur) return false;
  const b = body(cur);
  const r = range(cur);
  if (r === 0) return false;
  return lowerShadow(cur) >= b * 2 && upperShadow(cur) <= b && b / r <= 0.5;
}

export function isShootingStar(candles: Candle[], idx: number): boolean {
  const cur = candles[idx];
  if (!cur) return false;
  const b = body(cur);
  const r = range(cur);
  if (r === 0) return false;
  return upperShadow(cur) >= b * 2 && lowerShadow(cur) <= b && b / r <= 0.5;
}

export function isDoji(candles: Candle[], idx: number): boolean {
  const cur = candles[idx];
  if (!cur) return false;
  const r = range(cur);
  if (r === 0) return false;
  return body(cur) <= r * 0.1;
}

export function isTweezerTopBottom(candles: Candle[], idx: number): "top" | "bottom" | null {
  const cur = candles[idx];
  const prev = candles[idx - 1];
  if (!cur || !prev) return null;
  const tolerance = (range(cur) + range(prev)) / 2 * 0.1;

  const highsAligned = Math.abs(cur.high - prev.high) <= tolerance;
  const lowsAligned = Math.abs(cur.low - prev.low) <= tolerance;

  if (highsAligned && isBearish(cur) && isBullish(prev)) {
    return "top";
  }
  if (lowsAligned && isBullish(cur) && isBearish(prev)) {
    return "bottom";
  }
  return null;
}

export function isMarubozu(candles: Candle[], idx: number, side: Side): boolean {
  const cur = candles[idx];
  if (!cur) return false;
  const r = range(cur);
  if (r === 0) return false;
  const b = body(cur);
  const wickRatio = b / r;
  if (wickRatio < 0.8) return false;
  if (side === "LONG") {
    return isBullish(cur);
  }
  return isBearish(cur);
}
