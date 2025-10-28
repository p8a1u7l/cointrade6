import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnvFile } from './utils/env.js';

loadEnvFile();

const parseStrategyMode = (value) => {
  const normalized = (value ?? 'scalp').toLowerCase();
  if (normalized === 'scalp' || normalized === 'llm') {
    return normalized;
  }
  if (value != null) {
    process.emitWarning(`Unknown STRATEGY_MODE "${value}", defaulting to scalp strategy.`);
  }
  return 'scalp';
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const parseNumber = (value, fallback) => {
  const source = value ?? fallback;
  const numeric = Number(source);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid numeric configuration: ${source}`);
  }
  return numeric;
};

const clamp = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
};

const parseSymbols = (value) => {
  const raw = value && value.trim().length > 0 ? value : 'BTCUSDT,ETHUSDT';
  return raw
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
};

const parseList = (value, fallback) => {
  const source = value && value.trim().length > 0 ? value : fallback;
  return source
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
};

const strategyMode = parseStrategyMode(process.env.STRATEGY_MODE);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '../..');

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseNumber(process.env.PORT, 8080),
  binance: {
    apiKey: requireEnv('BINANCE_API_KEY'),
    apiSecret: requireEnv('BINANCE_API_SECRET'),
    useTestnet: (process.env.BINANCE_USE_TESTNET ?? 'true') === 'true',
    symbols: parseSymbols(process.env.BINANCE_SYMBOLS),
    symbolDiscovery: {
      enabled: (process.env.SYMBOL_DISCOVERY_ENABLED ?? 'true') === 'true',
      refreshIntervalSeconds: parseNumber(process.env.SYMBOL_DISCOVERY_REFRESH_SECONDS, 180),
      topMoverLimit: parseNumber(process.env.SYMBOL_DISCOVERY_TOP_LIMIT, 400),
      maxActiveSymbols: parseNumber(process.env.SYMBOL_DISCOVERY_MAX_ACTIVE, 400),
      minQuoteVolume: parseNumber(process.env.SYMBOL_DISCOVERY_MIN_QUOTE_VOLUME, 5_000_000),
      quoteAssets: parseList(process.env.SYMBOL_DISCOVERY_QUOTE_ASSETS, 'USDT'),
      routeLimit: parseNumber(process.env.SYMBOL_DISCOVERY_ROUTE_LIMIT, 10),
    },
  },
  openAi: {
    apiKey: strategyMode === 'scalp' ? process.env.OPENAI_API_KEY ?? '' : requireEnv('OPENAI_API_KEY'),
  },
  trading: {
    strategyMode,
    initialBalance: parseNumber(process.env.INITIAL_BALANCE, 100_000),
    loopIntervalSeconds: parseNumber(process.env.LOOP_INTERVAL_SECONDS, 30),
    maxPositionLeverage: parseNumber(process.env.MAX_POSITION_LEVERAGE, 5),
    userControls: (() => {
      const minLeverage = clamp(parseNumber(process.env.USER_CONTROL_MIN_LEVERAGE, 1), 1, 50);
      const maxLeverage = clamp(
        parseNumber(process.env.USER_CONTROL_MAX_LEVERAGE, 50),
        minLeverage,
        50
      );
      const defaultLeverage = clamp(
        parseNumber(process.env.USER_CONTROL_DEFAULT_LEVERAGE, 3),
        minLeverage,
        maxLeverage
      );

      const minAllocation = clamp(parseNumber(process.env.USER_CONTROL_MIN_ALLOCATION_PCT, 1), 1, 100);
      const maxAllocation = clamp(
        parseNumber(process.env.USER_CONTROL_MAX_ALLOCATION_PCT, 50),
        minAllocation,
        100
      );
      const defaultAllocation = clamp(
        parseNumber(process.env.USER_CONTROL_DEFAULT_ALLOCATION_PCT, 10),
        minAllocation,
        maxAllocation
      );

      return {
        minLeverage,
        maxLeverage,
        defaultLeverage,
        minAllocationPct: minAllocation,
        maxAllocationPct: maxAllocation,
        defaultAllocationPct: defaultAllocation,
      };
    })(),
  },
  logging: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
};
