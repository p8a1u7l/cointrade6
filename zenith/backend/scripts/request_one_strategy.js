import { requestStrategy } from '../src/clients/openaiClient.js';

const mockMarketContext = {
  rsi_14: 65.8,
  change_5m_pct: 0.82,
  vol_ratio: 1.45,
  edge_score: 0.68,
  current_price: 34250.50,
  price_change_24h: 2.5,
  volume_24h: 12500000000,
  high_24h: 34500.00,
  low_24h: 33200.00
};

(async () => {
  try {
    console.log('Requesting strategy for BTCUSDT with market data...');
    const result = await requestStrategy('BTCUSDT', mockMarketContext, {
      riskLevel: 3,
      leverage: 3,
      estimatedNotional: 120,
    });
    console.log('Strategy result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Strategy request failed:');
    console.error(error && error.message ? error.message : error);
    if (error && error.body) {
      try {
        console.error('Error body:', JSON.stringify(error.body, null, 2));
      } catch (e) {
        console.error('Error body (raw):', error.body);
      }
    }
    process.exit(1);
  }
})();
