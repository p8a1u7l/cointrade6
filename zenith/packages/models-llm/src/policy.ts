import { z } from "zod";
import cfg from "@repo/core/config";
import { VPLevels } from "@repo/core/schemas";
import { NswOutSchema } from "@repo/packages/signals/src/types";

const PolicyCandidateSchema = z.object({
  model: z.enum(["BREAKOUT", "MEAN", "EMA50"]),
  side: z.enum(["LONG", "SHORT", "NONE"]),
  reasons: z.array(z.string()).max(10),
});

const PolicyRequestSchema = z.object({
  ema: z.tuple([z.number(), z.number(), z.number()]),
  rsi: z.number(),
  atr: z.number(),
  vp: VPLevels,
  fvg: z.object({ has: z.boolean(), size: z.number() }),
  of: z.object({ buy: z.number(), sell: z.number(), ratio: z.number(), bubble: z.boolean() }),
  micro: z.object({ spreadBp: z.number(), slipBp: z.number(), latencyMs: z.number(), quoteAgeMs: z.number(), depthBias: z.number() }),
  session: z.enum(["ASIA","LONDON","NY","BRIDGE"]),
  nsw: NswOutSchema,
  candleAgeSec: z.number(),
  distanceFromEntry: z.number(),
  candidates: z.array(PolicyCandidateSchema),
});

const PolicyDecisionSchema = z.object({
  allow: z.boolean(),
  side: z.enum(["LONG", "SHORT", "NONE"]),
  model: z.enum(["BREAKOUT", "MEAN", "EMA50"]),
  maxHoldSec: z.number(),
  maxBars: z.number(),
  tpRR: z.number(),
  slRR: z.number(),
  entryHint: z.enum(["lvn","vah","val","ema25","ema50","fvg_edge","poc","next_va","na"]).or(z.string()),
  notes: z.array(z.string()).max(10),
});

export type PolicyCandidate = z.infer<typeof PolicyCandidateSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export async function callPolicyLLM(input: PolicyRequest): Promise<PolicyDecision> {
  const endpoint = cfg.models?.policy?.endpoint;
  if (!endpoint) {
    throw new Error("Policy LLM endpoint is not configured");
  }

  const body = JSON.stringify(input);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Policy service request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const parsed = PolicyDecisionSchema.parse(payload);
  return parsed;
}
