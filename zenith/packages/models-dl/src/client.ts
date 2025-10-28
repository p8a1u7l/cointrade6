import cfg from "@repo/core/config";
import { DlOutSchema, type DlOut } from "@repo/packages/signals/src/types";
import type { Features } from "@repo/core/schemas";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function resolveEndpoint(): string {
  const endpoint = cfg.models?.dl?.endpoint;
  if (!endpoint) {
    throw new Error("DL model endpoint is not configured");
  }
  return endpoint;
}

function buildPayload(symbol: string, features: Features) {
  return {
    symbol,
    ts: features.ts,
    features,
  };
}

function buildFallbackDl(features: Features): DlOut {
  const momentum = (features.ema25 - features.ema50) / Math.max(features.close, 1);
  const volatility = clamp(features.atr22 / Math.max(features.close, 1), 0, 0.1);
  const bias = clamp(momentum * 5, -1, 1);
  const up = clamp(0.5 + bias * 0.4, 0.05, 0.9);
  const down = clamp(0.5 - bias * 0.4, 0.05, 0.9);
  const flat = clamp(1 - up - down, 0.05, 0.4);
  const q = clamp((features.orderflow.buy / (features.orderflow.sell || 1)) / 3, 0.2, 0.9);
  const slipBp = clamp(features.micro.spreadBp * 1.5, 0.5, 10);
  const muRet = clamp(momentum * 100, -1, 1);
  const sigmaRet = clamp(volatility * 100, 0.2, 5);
  const fillProb = clamp(0.6 + q * 0.2, 0.4, 0.95);
  const slDistTick = Math.max(2, Math.round((features.atr22 / Math.max(features.tickSize, 1e-6)) * 0.6));
  const tp1RR = clamp(1.4 + q * 0.6, 1.2, 2.4);
  const tp2RR = clamp(tp1RR + 0.8, 1.8, 3.6);

  return {
    up,
    down,
    flat,
    q,
    muRet,
    sigmaRet,
    fillProb,
    slipBp,
    vol: features.atr22,
    sizeMul: clamp(1 + q * 0.5, 1, 2),
    slDistTick,
    tp1RR,
    tp2RR,
  };
}

export async function callDl(symbol: string, features: Features): Promise<DlOut> {
  const endpoint = resolveEndpoint();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(buildPayload(symbol, features)),
    });

    if (!response.ok) {
      throw new Error(`DL service request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    return DlOutSchema.parse(payload);
  } catch (error) {
    console.warn(`[signals] Falling back to heuristic DL output for ${symbol}:`, error);
    return buildFallbackDl(features);
  }
}
