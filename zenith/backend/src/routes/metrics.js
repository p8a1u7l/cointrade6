import { Router } from '../http/router.js';
import { analyticsStore } from '../store/analyticsStore.js';
import { loadAnalyticsArchive, analyticsArchivePath } from '../store/analyticsPersistence.js';
import { fetchEquitySnapshot } from '../services/equitySnapshot.js';
import { logger } from '../utils/logger.js';

const round = (value, digits = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
};

function mergePerformanceWithPositions(performance, positions) {
  const merged = new Map();

  for (const entry of performance ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    merged.set(entry.symbol, {
      ...entry,
      unrealized_pnl: round(entry.unrealized_pnl ?? 0),
    });
  }

  for (const position of positions ?? []) {
    if (!position || typeof position !== 'object') continue;
    const symbol = position.symbol;
    const positionAmt = Number(position.positionAmt);
    const entryPrice = Number(position.entryPrice);
    const unrealized = Number(position.unrealizedProfit ?? 0);
    if (!symbol || !Number.isFinite(positionAmt) || Math.abs(positionAmt) < 1e-8) {
      continue;
    }

    const existing = merged.get(symbol) ?? {
      symbol,
      realized_pnl: 0,
      net_contracts: 0,
      avg_entry_price: 0,
      total_volume: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      trades: 0,
      win_rate: 0,
    };

    merged.set(symbol, {
      ...existing,
      net_contracts: Number(positionAmt.toFixed(4)),
      avg_entry_price: Number.isFinite(entryPrice) ? round(entryPrice) : existing.avg_entry_price,
      unrealized_pnl: round((existing.unrealized_pnl ?? 0) + unrealized),
    });
  }

  return Array.from(merged.values()).map((entry) => ({
    ...entry,
    realized_pnl: round(entry.realized_pnl ?? 0),
    unrealized_pnl: round(entry.unrealized_pnl ?? 0),
  }));
}

export function createMetricsRouter(engine, binance) {
  const router = new Router();

  router.get('/', async (_req, res) => {
    try {
      const baseline = analyticsStore.getBaselineEquity();
      const snapshot = await fetchEquitySnapshot(binance, baseline);
      const normalized = analyticsStore.addEquity(snapshot);
      const winStats = analyticsStore.getWinStats();
      let positions = [];
      try {
        positions = await binance.fetchPositions();
      } catch (error) {
        logger.warn({ error }, 'Unable to fetch Binance positions for metrics');
      }
      const openPositions = (positions ?? []).filter((pos) =>
        Number.isFinite(pos?.positionAmt) && Math.abs(Number(pos.positionAmt)) > 1e-8
      );
      const unrealizedTotal = openPositions.reduce(
        (acc, pos) => acc + (Number(pos.unrealizedProfit ?? 0) || 0),
        0
      );
      const performance = mergePerformanceWithPositions(analyticsStore.getSymbolPerformance(), openPositions);

      res.json({
        balance: normalized.balance,
        equity: normalized.equity,
        pnlPercent: normalized.pnlPercent,
        realized: analyticsStore.getRealizedPnl(),
        unrealized: round(unrealizedTotal),
        riskLevel: engine.getRiskLevel(),
        leverage: engine.getUserLeverage(),
        allocationPct: engine.getAllocationPercent(),
        openAi: analyticsStore.getOpenAiUsage(),
        winRate: winStats.winRate,
        wins: winStats.wins,
        losses: winStats.losses,
        breakeven: winStats.breakeven,
        trades: winStats.trades,
        performance,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to refresh live equity metrics');
      const cached = analyticsStore.getLatestEquity();
      if (cached) {
        const winStats = analyticsStore.getWinStats();
        let positions = [];
        try {
          positions = await binance.fetchPositions();
        } catch (positionsError) {
          logger.warn({ error: positionsError }, 'Unable to refresh positions while serving cached metrics');
        }
        const openPositions = (positions ?? []).filter((pos) =>
          Number.isFinite(pos?.positionAmt) && Math.abs(Number(pos.positionAmt)) > 1e-8
        );
        const unrealizedTotal = openPositions.reduce(
          (acc, pos) => acc + (Number(pos.unrealizedProfit ?? 0) || 0),
          0
        );
        res.json({
          balance: cached.balance,
          equity: cached.equity,
          pnlPercent: cached.pnlPercent,
          realized: analyticsStore.getRealizedPnl(),
          unrealized: round(unrealizedTotal),
          riskLevel: engine.getRiskLevel(),
          leverage: engine.getUserLeverage(),
          allocationPct: engine.getAllocationPercent(),
          openAi: analyticsStore.getOpenAiUsage(),
          winRate: winStats.winRate,
          wins: winStats.wins,
          losses: winStats.losses,
          breakeven: winStats.breakeven,
          trades: winStats.trades,
          performance: mergePerformanceWithPositions(
            analyticsStore.getSymbolPerformance(),
            openPositions
          ),
        });
        return;
      }

      res.status(503).json({ error: 'Equity metrics are not available yet' });
    }
  });

  router.get('/equity/series', (req, res) => {
    const requestedLimit = Number(req.query.limit ?? '240');
    const points = analyticsStore.getEquitySeries(requestedLimit);
    if (points.length === 0) {
      res.json({ points: [], message: 'No equity history available yet' });
      return;
    }
    res.json({ points });
  });

  router.get('/archive', async (req, res) => {
    const requestedLimit = Number(req.query.limit ?? '1000');
    const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 1000;
    try {
      const events = await loadAnalyticsArchive(safeLimit);
      res.json({
        events,
        source: analyticsArchivePath,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to load analytics archive');
      res.status(500).json({ error: 'Failed to load analytics archive' });
    }
  });

  return router;
}
