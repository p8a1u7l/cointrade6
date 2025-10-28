import { IExchange } from "@repo/exchange-binance";
import cfg from "@repo/core/config";

export type RouteReport = {
  accepted: boolean;
  avgPrice?: number;
  filledQty?: number;
  slipBp?: number;
  latencyMs?: number;
  fills?: Array<{price:number, qty:number, ts:number}>;
  reason?: string;
}

export async function routeOrder(ex: IExchange, params:{
  symbol: string;
  side: "BUY"|"SELL";
  qty: number;
  limitPrice: number;
  maxReprices?: number;           // default cfg.scalp.repriceAttempts
  forbidMarket?: boolean;         // NSW High에서 true 가능
  signalAgeSec?: number;
  micro?: {
    spreadBp: number;
    expectedSlipBp: number;
    latencyMs: number;
    quoteAgeMs: number;
    depthBias: number;
  };
}): Promise<RouteReport> {
  const attempts = params.maxReprices ?? cfg.scalp?.repriceAttempts ?? 3;
  const delayCfg = cfg.scalp?.repriceDelayMs ?? { base: 60, step: 20 };
  const partialThreshold = cfg.scalp?.partialFillRatio ?? cfg.order?.maxPartialFillRatio ?? 0.6;
  const staleLimit = cfg.scalp?.signalStaleSec ?? 10;
  const slipCap = cfg.scalp?.slippageBpCap ?? cfg.microFilters.slippageBp;
  const spreadCap = cfg.scalp?.spreadBpCap ?? cfg.microFilters.spreadBp;
  const latencyCap = cfg.scalp?.latencyMs ?? cfg.microFilters.latencyMs;
  const quoteAgeCap = cfg.scalp?.quoteAgeMs ?? cfg.microFilters.quoteAgeMs;

  if (typeof params.signalAgeSec === "number" && params.signalAgeSec > staleLimit) {
    return { accepted:false, reason:"signal stale" };
  }

  if (params.micro) {
    const { spreadBp, expectedSlipBp, latencyMs, quoteAgeMs, depthBias } = params.micro;
    const depthThreshold = cfg.scalp?.depthBias?.[params.side === "BUY" ? "LONG" : "SHORT"] ?? 0.9;
    if (spreadBp > spreadCap || expectedSlipBp > slipCap || latencyMs > latencyCap || quoteAgeMs > quoteAgeCap || depthBias < depthThreshold) {
      return { accepted:false, reason:"micro filter reject" };
    }
  }

  let price = params.limitPrice;
  let cumulativeFills = 0;
  let avgPrice = 0;
  let lastLatency = 0;
  const fills: RouteReport["fills"] = [];

  const tickSizes = cfg.tickSize as Record<string, number>;
  const tick = tickSizes[params.symbol] ?? 0.1;

  for (let i=0;i<attempts;i++) {
    const t0 = Date.now();
    const ack = await ex.place({
      symbol: params.symbol,
      side: params.side,
      type: "LIMIT",
      timeInForce: "GTC",
      price,
      quantity: params.qty,
    }).catch((e)=>{ throw e; });
    lastLatency = Date.now()-t0;

    const executed = typeof ack.executedQty === "number" ? ack.executedQty : 0;
    const ratio = params.qty > 0 ? executed / params.qty : 0;
    if (ratio >= partialThreshold) {
      cumulativeFills += executed;
      avgPrice = executed > 0 ? (typeof ack.avgPrice === "number" && ack.avgPrice > 0 ? ack.avgPrice : price) : price;
      fills.push({price: avgPrice, qty: executed, ts: Date.now()});
      const slip = estimateSlipBp(avgPrice, params.limitPrice);
      if (slip > slipCap) {
        return { accepted:false, reason:"slippage above cap", avgPrice, filledQty:cumulativeFills, slipBp: slip };
      }
      return { accepted:true, avgPrice, filledQty:cumulativeFills, slipBp: slip, latencyMs:lastLatency, fills };
    }

    await delay(delayCfg.base + i*delayCfg.step);
    price = reprice(params.side, price, tick);
  }

  if (params.forbidMarket) {
    return { accepted:false, reason:"market forbidden by policy/NSW" };
  }

  // IOC clean-up attempt within slip guard
  const iocStart = Date.now();
  const iocAck = await ex.place({
    symbol: params.symbol,
    side: params.side,
    type: "LIMIT",
    timeInForce: "IOC",
    price,
    quantity: params.qty,
  });
  lastLatency = Date.now() - iocStart;
  const iocExecuted = typeof iocAck.executedQty === "number" && iocAck.executedQty > 0 ? iocAck.executedQty : params.qty;
  const iocPrice = typeof iocAck.avgPrice === "number" && iocAck.avgPrice > 0 ? iocAck.avgPrice : price;
  fills.push({ price: iocPrice, qty: iocExecuted, ts: Date.now() });
  const iocSlip = estimateSlipBp(iocPrice, params.limitPrice);
  if (iocSlip <= slipCap) {
    return { accepted:true, avgPrice: iocPrice, filledQty: iocExecuted, slipBp: iocSlip, latencyMs: lastLatency, fills };
  }

  // Final fallback: market with slip guard
  const m0 = Date.now();
  const mkt = await ex.place({
    symbol: params.symbol,
    side: params.side,
    type: "MARKET",
    quantity: params.qty,
    price: params.limitPrice,
  });
  lastLatency = Date.now()-m0;
  const done = await waitFill(ex, params.symbol, mkt, 250);
  if (done) {
    avgPrice = done.avgPrice;
    cumulativeFills = done.filled;
    const slip = estimateSlipBp(avgPrice, params.limitPrice);
    if (slip > slipCap) {
      return { accepted:false, reason:"slippage above cap", avgPrice, filledQty:cumulativeFills, slipBp: slip };
    }
    fills.push({price: avgPrice, qty: done.filled, ts: Date.now()});
    return { accepted:true, avgPrice, filledQty:cumulativeFills, slipBp: slip, latencyMs:lastLatency, fills };
  }
  return { accepted:false, reason:"fallback market fill failed" };
}

function reprice(side:"BUY"|"SELL", px:number, tick:number): number {
  return side==="BUY" ? (px + tick) : (px - tick);
}
function delay(ms:number){ return new Promise(r=>setTimeout(r, ms)); }
function estimateSlipBp(fill:number, limit:number): number {
  if (!Number.isFinite(fill) || !Number.isFinite(limit) || limit === 0) return 0;
  const bp = Math.abs((fill-limit)/limit)*10000;
  return bp;
}

async function waitFill(ex:IExchange, symbol:string, ack:any, ms=250): Promise<{filled:number, avgPrice:number}|null> {
  await delay(ms);
  const avg = Number.isFinite(ack?.avgPrice) && ack.avgPrice > 0 ? ack.avgPrice : ack?.price ?? 0;
  const filled = Number.isFinite(ack?.executedQty) && ack.executedQty > 0 ? ack.executedQty : ack?.origQty ?? 0;
  return {filled, avgPrice: avg};
}

export async function closePosition(ex: IExchange, params:{
  symbol: string;
  side: "BUY"|"SELL";
  qty: number;
  price: number;
}): Promise<RouteReport> {
  const { symbol, side, qty, price } = params;
  if (!Number.isFinite(price) || price <= 0) {
    return { accepted: false, reason: "invalid price" };
  }

  const start = Date.now();
  const ack = await ex.place({
    symbol,
    side,
    type: "LIMIT",
    timeInForce: "IOC",
    quantity: qty,
    price,
    reduceOnly: true,
  });
  const latencyMs = Date.now() - start;
  const avgPriceSource = typeof ack.avgPrice === "number" && Number.isFinite(ack.avgPrice) && ack.avgPrice > 0
    ? ack.avgPrice
    : ack.price;
  const filledQtySource = typeof ack.executedQty === "number" && Number.isFinite(ack.executedQty) && ack.executedQty > 0
    ? ack.executedQty
    : ack.origQty;
  const fills = [{ price: avgPriceSource, qty: filledQtySource, ts: Date.now() }];
  const slip = Number.isFinite(avgPriceSource)
    ? estimateSlipBp(avgPriceSource, price)
    : 0;
  if (slip > (cfg.scalp?.slippageBpCap ?? cfg.microFilters.slippageBp)) {
    return { accepted: false, reason: "slippage above cap", avgPrice: avgPriceSource, filledQty: filledQtySource, slipBp: slip };
  }
  return { accepted: true, avgPrice: avgPriceSource, filledQty: filledQtySource, latencyMs, slipBp: slip, fills };
}
