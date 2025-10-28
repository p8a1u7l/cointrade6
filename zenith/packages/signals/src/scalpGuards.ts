import cfg from "@repo/core/config";

type Side = "LONG" | "SHORT";

export function computeSignalFreshSec(signalTs: number, now: number = Date.now()): number {
  return Math.max(0, (now - signalTs) / 1000);
}

export function isSignalFresh(signalTs: number, now: number = Date.now()): boolean {
  const limit = cfg.scalp?.signalStaleSec ?? 10;
  return computeSignalFreshSec(signalTs, now) <= limit;
}

export function shouldForceFlat(params: {
  holdSec: number;
  barsHeld: number;
  maxHoldSec?: number;
  maxBars?: number;
}): boolean {
  const maxHold = params.maxHoldSec ?? cfg.scalp?.maxHoldSec ?? 150;
  const maxBars = params.maxBars ?? cfg.scalp?.maxBars ?? 3;
  if (params.holdSec >= maxHold) return true;
  if (params.barsHeld >= maxBars) return true;
  return false;
}

type EventType = "stop" | "slip";

export class CooldownTracker {
  private stopEvents = new Map<string, number[]>();
  private slipEvents = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();

  private prune(arr: number[], now: number): number[] {
    const windowMs = cfg.scalp?.cooldownWindowMs ?? 120_000;
    return arr.filter((ts) => now - ts <= windowMs);
  }

  private markBlocked(symbol: string, now: number): void {
    const cooldown = cfg.scalp?.cooldownMs ?? 60_000;
    this.blockedUntil.set(symbol, now + cooldown);
  }

  register(symbol: string, type: EventType, now: number = Date.now()): void {
    if (type === "stop") {
      const arr = this.prune(this.stopEvents.get(symbol) ?? [], now);
      arr.push(now);
      this.stopEvents.set(symbol, arr);
      if (arr.length >= 2) {
        this.markBlocked(symbol, now);
      }
    } else {
      const arr = this.prune(this.slipEvents.get(symbol) ?? [], now);
      arr.push(now);
      this.slipEvents.set(symbol, arr);
      if (arr.length >= 2) {
        this.markBlocked(symbol, now);
      }
    }
  }

  clear(symbol: string): void {
    this.stopEvents.delete(symbol);
    this.slipEvents.delete(symbol);
    this.blockedUntil.delete(symbol);
  }

  isBlocked(symbol: string, now: number = Date.now()): boolean {
    const until = this.blockedUntil.get(symbol);
    if (!until) return false;
    if (now >= until) {
      this.blockedUntil.delete(symbol);
      return false;
    }
    return true;
  }
}

export function depthBiasFor(side: Side): number {
  return cfg.scalp?.depthBias?.[side] ?? 0.9;
}
