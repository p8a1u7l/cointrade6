export function buildPrompt(symbol, marketContext) {
  return [
    `Symbol: ${symbol}`,
    'Metrics JSON:',
    JSON.stringify(marketContext, null, 2),
    'Analyze the metrics to determine trading bias. Consider all provided values.',
  ].join('\n');
}
