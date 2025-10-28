export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
}

export interface PlaceOrderAck {
  orderId: string;
  price: number;
  origQty: number;
  avgPrice?: number;
  executedQty?: number;
}

export interface IExchange {
  place(params: PlaceOrderParams): Promise<PlaceOrderAck>;
}

export class MockExchange implements IExchange {
  async place(params: PlaceOrderParams): Promise<PlaceOrderAck> {
    const price = params.type === "MARKET"
      ? params.price ?? 0
      : params.price ?? 0;
    return {
      orderId: `${params.symbol}-${Date.now()}`,
      price,
      origQty: params.quantity,
      avgPrice: price,
      executedQty: params.quantity,
    };
  }
}
