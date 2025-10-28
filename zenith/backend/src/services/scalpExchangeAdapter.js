const MARKET_ORDER = 'MARKET';

const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export class BinanceExchangeAdapter {
  constructor(client) {
    this.client = client;
  }

  async place(params) {
    const { symbol, side, type, quantity, price, timeInForce, reduceOnly } = params;
    const desiredQty = Math.max(0, toNumber(quantity));
    if (!Number.isFinite(desiredQty) || desiredQty <= 0) {
      throw new Error(`Invalid quantity for ${symbol}`);
    }

    const referencePrice = toNumber(price, 0);
    const normalized = await this.client.ensureTradableQuantity(symbol, desiredQty, referencePrice > 0 ? referencePrice : undefined);
    if (!Number.isFinite(normalized.quantity) || normalized.quantity <= 0) {
      throw new Error(`Unable to normalize quantity for ${symbol}`);
    }

    const qtyParam = normalized.quantityText ?? normalized.quantity;

    if (type === MARKET_ORDER) {
      const response = await this.client.placeMarketOrder(symbol, side, qtyParam, {
        reduceOnly: reduceOnly === true,
        responseType: 'RESULT',
      });
      return {
        orderId: String(response.orderId),
        price: referencePrice > 0 ? referencePrice : toNumber(response.avgPrice, toNumber(response.price, 0)),
        origQty: normalized.quantity,
        avgPrice: toNumber(response.avgPrice, toNumber(response.price, 0)),
        executedQty: toNumber(response.executedQty, normalized.quantity),
      };
    }

    const limitPrice = toNumber(price);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      throw new Error(`Limit price required for ${symbol}`);
    }

    const response = await this.client.placeLimitOrder(symbol, side, qtyParam, limitPrice, {
      timeInForce: timeInForce ?? 'GTC',
      reduceOnly: reduceOnly === true,
      responseType: 'RESULT',
    });

    return {
      orderId: String(response.orderId),
      price: limitPrice,
      origQty: normalized.quantity,
      avgPrice: toNumber(response.avgPrice, limitPrice),
      executedQty: toNumber(response.executedQty, normalized.quantity),
    };
  }
}

export function createBinanceExchangeAdapter(client) {
  if (!client) {
    throw new Error('Binance client is required to build exchange adapter');
  }
  return new BinanceExchangeAdapter(client);
}
