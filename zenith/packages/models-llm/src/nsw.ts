import cfg from "@repo/core/config";
import { NswOutSchema, type NswOut } from "@repo/packages/signals/src/types";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function resolveEndpoint(): string {
  const endpoint = cfg.models?.nsw?.endpoint;
  if (!endpoint) {
    throw new Error("NSW model endpoint is not configured");
  }
  return endpoint;
}

function buildFallbackNsw(symbol: string): NswOut {
  const baseSpreadCap = 4;
  const now = Date.now();
  const dayCycle = Math.sin((now / 3_600_000) % (2 * Math.PI));
  const aggImpact = clamp(Math.abs(dayCycle) * 0.6, 0.05, 0.7);
  const grade = aggImpact > 0.45 ? "High" : aggImpact > 0.25 ? "Notice" : "None";
  const sizeMul = grade === "High" ? 0.7 : 1;
  const forbidMarket = grade === "High";
  const modelPref = grade === "High" ? "MEAN" : "BREAKOUT";
  return {
    aggImpact,
    grade,
    policy: {
      sizeMul,
      forbidMarket,
      modelPref,
      spreadCapBp: grade === "High" ? baseSpreadCap * 0.8 : baseSpreadCap,
    },
  };
}

export async function callNSW(symbol: string): Promise<NswOut> {
  const endpoint = resolveEndpoint();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ symbol }),
    });

    if (!response.ok) {
      throw new Error(`NSW service request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    return NswOutSchema.parse(payload);
  } catch (error) {
    console.warn(`[signals] Falling back to heuristic NSW output for ${symbol}:`, error);
    return buildFallbackNsw(symbol);
  }
}
