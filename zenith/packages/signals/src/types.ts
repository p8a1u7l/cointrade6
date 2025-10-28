import { z } from "zod";
import {
  Candle, Depth, Trade, VPLevels, FVGZone, Features,
} from "@repo/core/schemas";

export const DlOutSchema = z.object({
  up: z.number(), down: z.number(), flat: z.number(),
  q: z.number().min(0).max(1),
  muRet: z.number(), sigmaRet: z.number().nonnegative(),
  fillProb: z.number().min(0).max(1),
  slipBp: z.number().nonnegative(),
  vol: z.number().nonnegative(),
  sizeMul: z.number().positive(),
  slDistTick: z.number().int().nonnegative(),
  tp1RR: z.number().positive(),
  tp2RR: z.number().positive().optional(),
});
export type DlOut = z.infer<typeof DlOutSchema>;

export const NswOutSchema = z.object({
  aggImpact: z.number().min(0).max(1),
  grade: z.enum(["None","Notice","High","Critical"]),
  policy: z.object({
    sizeMul: z.number().positive(),
    forbidMarket: z.boolean(),
    modelPref: z.enum(["BREAKOUT","MEAN","EMA50"]),
    spreadCapBp: z.number().positive(),
  }),
});
export type NswOut = z.infer<typeof NswOutSchema>;

export const CandidateSchema = z.object({
  signal: z.enum(["LONG","SHORT","NONE"]),
  model: z.enum(["BREAKOUT","MEAN","EMA50","NONE"]),
  quality: z.number().min(0).max(1),
  entryHint: z.object({ level: z.enum(["lvn","vah","val","ema25","ema50","fvg_edge","poc","next_va","na"]) }),
  stopHint: z.object({ type: z.enum(["swing","chandelier"]), distanceTick: z.number().int().nonnegative() }),
  tpPlan: z.object({ tp1RR: z.number().positive(), tp2RR: z.number().positive().optional(), target: z.enum(["poc","next_va","na"]) }),
  micro: z.object({
    spreadBp: z.number(),
    latencyMs: z.number(),
    quoteAgeMs: z.number(),
    depthBias: z.number(),
  }),
  reasons: z.array(z.string()),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const DecisionSchema = z.object({
  candidates: z.array(CandidateSchema),
  meta: z.object({
    session: z.enum(["ASIA","LONDON","NY","BRIDGE"]),
    regime: z.enum(["BULLISH","BEARISH","RANGE"]),
    qualityThreshold: z.number(),
  }),
});
export type Decision = z.infer<typeof DecisionSchema>;
