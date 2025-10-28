import { Candidate, Decision } from "@repo/packages/signals/src/types";
import { PolicyDecision, callPolicyLLM, PolicyRequest } from "@repo/models-llm/policy";
import { computeSignalFreshSec } from "./scalpGuards";
import { strategyQualityThreshold } from "./quality";

function buildPolicyPayload(input:{
  features:any;
  dl:any;
  nsw:any;
  candidates: Candidate[];
}): PolicyRequest {
  const features = input.features;
  const dl = input.dl;
  const nsw = input.nsw;
  const sorted = [...input.candidates].sort((a,b)=>b.quality-a.quality).slice(0,5);
  const depthBias = features.micro?.bidQty10 && features.micro?.askQty10
    ? features.micro.bidQty10 / Math.max(1, features.micro.askQty10)
    : 1;
  const signalAgeSec = features.signalAgeSec ?? computeSignalFreshSec(features.ts ?? Date.now());
  const ratio = features.orderflow?.sell ? features.orderflow.buy / Math.max(1e-9, features.orderflow.sell) : 0;
  const payload: PolicyRequest = {
    ema: [features.ema25, features.ema50, features.ema100],
    rsi: features.rsi14,
    atr: features.atr22,
    vp: features.vp,
    fvg: { has: Array.isArray(features.fvg) && features.fvg.length>0, size: features.fvg?.[0]?.size ?? 0 },
    of: { buy: features.orderflow.buy, sell: features.orderflow.sell, ratio, bubble: features.orderflow.bubble },
    micro: {
      spreadBp: features.micro.spreadBp,
      slipBp: dl?.slipBp ?? features.micro.spreadBp * 0.6,
      latencyMs: features.micro.latencyMs,
      quoteAgeMs: features.micro.quoteAgeMs,
      depthBias,
    },
    session: features.session,
    nsw,
    candleAgeSec: features.candleAgeSec ?? signalAgeSec,
    distanceFromEntry: features.atr22 > 0 ? Math.abs(features.close - features.vp.poc) / features.atr22 : 0,
    candidates: sorted.map(c => ({
      model: c.model === "NONE" ? "BREAKOUT" : c.model,
      side: c.signal === "NONE" ? "NONE" : (c.signal === "LONG" ? "LONG" : "SHORT"),
      reasons: c.reasons.slice(0,6),
    })),
  };
  return payload;
}

export async function decideWithPolicy(input:{
  features:any, dl:any, nsw:any, candidates: Candidate[]
}): Promise<Decision> {
  const sorted = [...input.candidates].sort((a,b)=>b.quality-a.quality).slice(0,5);
  const policyPayload = buildPolicyPayload({ features: input.features, dl: input.dl, nsw: input.nsw, candidates: sorted });
  const res: PolicyDecision = await callPolicyLLM(policyPayload);

  let final: Candidate[] = sorted;
  if (!res.allow || sorted.length === 0) {
    const fallback = sorted[0] ?? input.candidates[0];
    final = fallback ? [{
      ...fallback,
      signal: "NONE",
      model: "NONE",
      quality: 0,
      reasons: [...fallback.reasons, "policy: disallow"],
    }] : [];
  } else {
    const pick = sorted.find(c => c.model === res.model && c.signal !== "NONE");
    if (pick) {
      pick.quality = Math.min(pick.quality, 1);
      pick.tpPlan.tp1RR = res.tpRR;
      if (typeof res.entryHint === "string" && ["lvn","vah","val","ema25","ema50","fvg_edge","poc","next_va","na"].includes(res.entryHint)) {
        pick.entryHint.level = res.entryHint as typeof pick.entryHint.level;
      }
      pick.reasons = [...pick.reasons, ...res.notes.slice(0,3)];
    }
  }

  const minThreshold = Math.min(
    strategyQualityThreshold("BREAKOUT"),
    strategyQualityThreshold("MEAN"),
    strategyQualityThreshold("EMA50"),
  );

  return {
    candidates: final,
    meta: {
      session: input.features.session,
      regime: input.features.regime,
      qualityThreshold: minThreshold,
    }
  };
}
