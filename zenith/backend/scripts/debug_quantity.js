import { BinanceClient } from '../src/clients/binanceClient.js';

async function main() {
  const [symbolArg, qtyArg, priceArg] = process.argv.slice(2);
  if (!symbolArg || !qtyArg) {
    console.error('Usage: node scripts/debug_quantity.js SYMBOL DESIRED_QTY [REFERENCE_PRICE]');
    process.exit(1);
  }

  const symbol = symbolArg.toUpperCase();
  const desiredQty = Number(qtyArg);
  const referencePrice = priceArg !== undefined ? Number(priceArg) : undefined;

  const client = new BinanceClient();
  const normalized = await client.ensureTradableQuantity(symbol, desiredQty, referencePrice);
  console.log(JSON.stringify({ symbol, desiredQty, referencePrice, normalized }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
