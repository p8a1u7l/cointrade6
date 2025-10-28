// 필요한 최소 필드만 예시 (이미 있을 경우 누락 필드만 추가)
import { z } from "zod";
export const Candle = z.object({ ts:z.number(), open:z.number(), high:z.number(), low:z.number(), close:z.number(), volume:z.number() });
export type Candle = z.infer<typeof Candle>;

export const Depth = z.object({ price:z.number(), qty:z.number() });
export type Depth = z.infer<typeof Depth>;

export const Trade = z.object({ price:z.number(), qty:z.number(), side:z.enum(["buy","sell"]), ts:z.number() });
export type Trade = z.infer<typeof Trade>;

export const VPLevels = z.object({ vah:z.number(), val:z.number(), poc:z.number(), lvn: z.array(z.number()).optional() });
export type VPLevels = z.infer<typeof VPLevels>;

export const FVGZone = z.object({ type:z.enum(["bullish","bearish"]), from:z.number(), to:z.number(), size:z.number() });
export type FVGZone = z.infer<typeof FVGZone>;

export const Features = z.object({
  ts: z.number(),
  symbol: z.string(),
  candles: z.array(Candle),
  ema25: z.number(), ema50: z.number(), ema100: z.number(),
  rsi14: z.number(),
  atr22: z.number(),
  vp: VPLevels,
  fvg: z.array(FVGZone).optional(),
  fvgAvgSize: z.number().optional(),
  orderflow: z.object({ buy:z.number(), sell:z.number(), bubble:z.boolean() }),
  micro: z.object({ spreadBp:z.number(), latencyMs:z.number(), quoteAgeMs:z.number(), bidQty10:z.number(), askQty10:z.number() }),
  close: z.number(),
  tickSize: z.number(),
  availableUSDT: z.number().default(1000),
  session: z.enum(["ASIA","LONDON","NY","BRIDGE"]),
  regime: z.enum(["BULLISH","BEARISH","RANGE"]),
  candleAgeSec: z.number().optional(),
  signalAgeSec: z.number().optional(),
  trades: z.array(Trade).optional(),
}).strict();
export type Features = z.infer<typeof Features>;
