import { persistAnalyticsEvent } from './analyticsPersistence.js';
import { logger } from '../utils/logger.js';

const round = (value, digits = 2) => Number(value.toFixed(digits));

const serializeOpenAiUsage = (usage) => ({
  promptTokens: usage.promptTokens,
  completionTokens: usage.completionTokens,
  totalTokens: usage.totalTokens,
  inputCost: usage.inputCost,
  outputCost: usage.outputCost,
  totalCost: usage.totalCost,
  calls: usage.calls,
  byModel: Array.from(usage.byModel.entries()).map(([model, stats]) => ({
    model,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    totalTokens: stats.totalTokens,
    inputCost: stats.inputCost,
    outputCost: stats.outputCost,
    totalCost: stats.totalCost,
    calls: stats.calls,
  })),
});

const deserializeOpenAiUsage = (data) => {
  const usage = {
    promptTokens: Number(data?.promptTokens ?? 0),
    completionTokens: Number(data?.completionTokens ?? 0),
    totalTokens: Number(data?.totalTokens ?? 0),
    inputCost: Number(data?.inputCost ?? 0),
    outputCost: Number(data?.outputCost ?? 0),
    totalCost: Number(data?.totalCost ?? 0),
    calls: Number(data?.calls ?? 0),
    byModel: new Map(),
  };
  if (Array.isArray(data?.byModel)) {
    for (const entry of data.byModel) {
      if (!entry || typeof entry !== 'object') continue;
      const model = typeof entry.model === 'string' && entry.model.trim().length > 0 ? entry.model : 'unknown';
      usage.byModel.set(model, {
        model,
        promptTokens: Number(entry.promptTokens ?? 0),
        completionTokens: Number(entry.completionTokens ?? 0),
        totalTokens: Number(entry.totalTokens ?? 0),
        inputCost: Number(entry.inputCost ?? 0),
        outputCost: Number(entry.outputCost ?? 0),
        totalCost: Number(entry.totalCost ?? 0),
        calls: Number(entry.calls ?? 0),
      });
    }
  }
  return usage;
};

export class AnalyticsStore {
  constructor() {
    this.equitySnapshots = [];
    this.signals = [];
    this.symbolStats = new Map();
    this.maxEntries = 1000;
    this.baselineEquity = undefined;
    this.openAiUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      calls: 0,
      byModel: new Map(),
    };
  }

  addSignal(decision, riskLevel, options = {}) {
    const record = {
      created_at: new Date().toISOString(),
      symbol: decision.symbol,
      bias: decision.bias,
      confidence: decision.confidence,
      risk_level: riskLevel,
      leverage: Number.isFinite(options.leverage) ? Number(options.leverage) : undefined,
      allocation_pct: Number.isFinite(options.allocationPct) ? Number(options.allocationPct) : undefined,
    };
    this.signals.push(record);
    if (this.signals.length > this.maxEntries) {
      this.signals.shift();
    }
    if (options.persist !== false) {
      void persistAnalyticsEvent({ type: 'signal', data: record }).catch((error) => {
        logger.warn({ error }, 'Failed to persist signal event');
      });
    }
  }

  addExecution(result, decision, options = {}) {
    const direction = decision.bias === 'long' ? 1 : decision.bias === 'short' ? -1 : 0;
    const filledQty = Number(result.filledQty ?? result.executedQty ?? result.quantity ?? 0);
    if (direction === 0 || !Number.isFinite(filledQty) || filledQty <= 0) {
      return;
    }

    const signedQty = filledQty * direction;
    const now = new Date().toISOString();
    const existing =
      this.symbolStats.get(decision.symbol) ?? {
        netContracts: 0,
        avgEntryPrice: 0,
        realizedPnl: 0,
        totalVolume: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        trades: 0,
        lastUpdated: now,
      };

    const resolvedFillPrice = (() => {
      const candidates = [
        result.avgPrice,
        result.price,
        decision.fillPrice,
        decision.entryPrice,
        decision.referencePrice,
      ];
      for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
          return numeric;
        }
      }
      return 0;
    })();

    const effectiveFillPrice = (() => {
      const candidates = [
        resolvedFillPrice,
        existing.avgEntryPrice,
        decision.entryPrice,
        decision.referencePrice,
      ];
      for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
          return numeric;
        }
      }
      return 0;
    })();

    if (existing.wins === undefined) existing.wins = 0;
    if (existing.losses === undefined) existing.losses = 0;
    if (existing.breakeven === undefined) existing.breakeven = 0;
    if (existing.trades === undefined) existing.trades = 0;

    const previousQty = existing.netContracts;
    const previousAbs = Math.abs(previousQty);
    const incomingAbs = Math.abs(signedQty);

    existing.totalVolume += incomingAbs;
    existing.lastUpdated = now;

    if (previousQty === 0 || Math.sign(previousQty) === Math.sign(signedQty)) {
      const combined = previousAbs + incomingAbs;
      existing.avgEntryPrice =
        combined === 0
          ? 0
          : (existing.avgEntryPrice * previousAbs + effectiveFillPrice * incomingAbs) / combined;
      existing.netContracts = previousQty + signedQty;
    } else {
      const closingQty = Math.min(previousAbs, incomingAbs);
      const pnlPerContract =
        Math.sign(previousQty) > 0
          ? effectiveFillPrice - existing.avgEntryPrice
          : existing.avgEntryPrice - effectiveFillPrice;
      const realized = closingQty * pnlPerContract;
      existing.realizedPnl += realized;
      if (closingQty > 0) {
        existing.trades += 1;
        const epsilon = 1e-8;
        if (realized > epsilon) {
          existing.wins += 1;
        } else if (realized < -epsilon) {
          existing.losses += 1;
        } else {
          existing.breakeven += 1;
        }
      }

      const remainingFromExisting = previousAbs - closingQty;
      const remainingFromIncoming = incomingAbs - closingQty;

      if (remainingFromExisting > 0) {
        existing.netContracts = Math.sign(previousQty) * remainingFromExisting;
      } else if (remainingFromIncoming > 0) {
        existing.netContracts = Math.sign(signedQty) * remainingFromIncoming;
        existing.avgEntryPrice = effectiveFillPrice;
      } else {
        existing.netContracts = 0;
        existing.avgEntryPrice = 0;
      }
    }

    this.symbolStats.set(decision.symbol, existing);
    if (options.persist !== false) {
      const payload = {
        symbol: decision.symbol,
        netContracts: existing.netContracts,
        avgEntryPrice: existing.avgEntryPrice,
        realizedPnl: existing.realizedPnl,
        totalVolume: existing.totalVolume,
        wins: existing.wins ?? 0,
        losses: existing.losses ?? 0,
        breakeven: existing.breakeven ?? 0,
        trades: existing.trades ?? 0,
        lastUpdated: existing.lastUpdated,
      };
      void persistAnalyticsEvent({ type: 'execution', data: payload }).catch((error) => {
        logger.warn({ error }, 'Failed to persist execution event');
      });
    }
  }

  recordOpenAiUsage(usage, options = {}) {
    if (!usage) {
      return;
    }
    const toNumber = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    };
    const attempts = Array.isArray(usage.attempts) && usage.attempts.length > 0 ? usage.attempts : null;
    const aggregated = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    };

    const recordModelUsage = (model, stats) => {
      const key = typeof model === 'string' && model.trim().length > 0 ? model : 'unknown';
      const entry = this.openAiUsage.byModel.get(key) ?? {
        model: key,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        calls: 0,
      };
      entry.promptTokens += stats.promptTokens;
      entry.completionTokens += stats.completionTokens;
      entry.totalTokens += stats.totalTokens;
      entry.inputCost += stats.inputCost;
      entry.outputCost += stats.outputCost;
      entry.totalCost += stats.totalCost;
      entry.calls += 1;
      this.openAiUsage.byModel.set(key, entry);
    };

    if (attempts) {
      for (const attempt of attempts) {
        const promptTokens = toNumber(attempt.promptTokens) ?? 0;
        const completionTokens = toNumber(attempt.completionTokens) ?? 0;
        const totalTokens = toNumber(attempt.totalTokens) ?? promptTokens + completionTokens;
        const inputCost = toNumber(attempt.inputCost) ?? 0;
        const outputCost = toNumber(attempt.outputCost) ?? 0;
        const totalCost = toNumber(attempt.totalCost) ?? inputCost + outputCost;

        aggregated.promptTokens += promptTokens;
        aggregated.completionTokens += completionTokens;
        aggregated.totalTokens += totalTokens;
        aggregated.inputCost += inputCost;
        aggregated.outputCost += outputCost;
        aggregated.totalCost += totalCost;

        this.openAiUsage.calls += 1;
        recordModelUsage(attempt.model ?? usage.model, {
          promptTokens,
          completionTokens,
          totalTokens,
          inputCost,
          outputCost,
          totalCost,
        });
      }
    } else {
      const promptTokens = toNumber(usage.promptTokens) ?? 0;
      const completionTokens = toNumber(usage.completionTokens) ?? 0;
      const totalTokens = toNumber(usage.totalTokens) ?? promptTokens + completionTokens;
      const inputCost = toNumber(usage.inputCost) ?? 0;
      const outputCost = toNumber(usage.outputCost) ?? 0;
      const totalCost = toNumber(usage.totalCost) ?? inputCost + outputCost;

      aggregated.promptTokens += promptTokens;
      aggregated.completionTokens += completionTokens;
      aggregated.totalTokens += totalTokens;
      aggregated.inputCost += inputCost;
      aggregated.outputCost += outputCost;
      aggregated.totalCost += totalCost;

      this.openAiUsage.calls += 1;
      recordModelUsage(usage.model, {
        promptTokens,
        completionTokens,
        totalTokens,
        inputCost,
        outputCost,
        totalCost,
      });
    }

    this.openAiUsage.promptTokens += aggregated.promptTokens;
    this.openAiUsage.completionTokens += aggregated.completionTokens;
    this.openAiUsage.totalTokens += aggregated.totalTokens;
    this.openAiUsage.inputCost += aggregated.inputCost;
    this.openAiUsage.outputCost += aggregated.outputCost;
    this.openAiUsage.totalCost += aggregated.totalCost;
    if (options.persist !== false) {
      const snapshot = serializeOpenAiUsage(this.openAiUsage);
      void persistAnalyticsEvent({ type: 'openai_usage', data: snapshot }).catch((error) => {
        logger.warn({ error }, 'Failed to persist OpenAI usage event');
      });
    }
  }

  getBaselineEquity() {
    return this.baselineEquity;
  }

  addEquity(snapshot, options = {}) {
    if (this.baselineEquity === undefined) {
      this.baselineEquity = snapshot.baseline ?? snapshot.equity;
    }

    const basis = this.baselineEquity === 0 ? snapshot.equity : this.baselineEquity;
    const pnlPercent = basis === 0 ? 0 : ((snapshot.equity - basis) / basis) * 100;
    const normalized = {
      balance: snapshot.balance,
      equity: snapshot.equity,
      pnlPercent,
      timestamp: snapshot.timestamp,
    };

    this.equitySnapshots.push(normalized);
    if (this.equitySnapshots.length > this.maxEntries) {
      this.equitySnapshots.shift();
    }
    if (options.persist !== false) {
      const payload = {
        ...normalized,
        baseline: this.baselineEquity,
      };
      void persistAnalyticsEvent({ type: 'equity', data: payload }).catch((error) => {
        logger.warn({ error }, 'Failed to persist equity snapshot');
      });
    }
    return normalized;
  }

  getLatestEquity() {
    return this.equitySnapshots[this.equitySnapshots.length - 1];
  }

  getRealizedPnl() {
    let total = 0;
    for (const stats of this.symbolStats.values()) {
      total += stats.realizedPnl;
    }
    return round(total);
  }

  getEquitySeries(limit = 240) {
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), this.maxEntries))
      : Math.min(240, this.maxEntries);
    const start = Math.max(this.equitySnapshots.length - safeLimit, 0);
    return this.equitySnapshots.slice(start).map((entry) => ({
      timestamp: entry.timestamp,
      equity: Number(entry.equity),
      balance: Number(entry.balance),
      pnlPercent: Number(entry.pnlPercent),
    }));
  }

  getOpenAiUsage() {
    const byModel = Array.from(this.openAiUsage.byModel.values()).map((entry) => ({
      model: entry.model,
      calls: entry.calls,
      promptTokens: Math.max(0, Math.round(entry.promptTokens)),
      completionTokens: Math.max(0, Math.round(entry.completionTokens)),
      totalTokens: Math.max(0, Math.round(entry.totalTokens)),
      inputCost: round(entry.inputCost, 6),
      outputCost: round(entry.outputCost, 6),
      totalCost: round(entry.totalCost, 6),
    }));

    byModel.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      promptTokens: Math.max(0, Math.round(this.openAiUsage.promptTokens)),
      completionTokens: Math.max(0, Math.round(this.openAiUsage.completionTokens)),
      totalTokens: Math.max(0, Math.round(this.openAiUsage.totalTokens)),
      inputCost: round(this.openAiUsage.inputCost, 6),
      outputCost: round(this.openAiUsage.outputCost, 6),
      totalCost: round(this.openAiUsage.totalCost, 6),
      calls: this.openAiUsage.calls,
      byModel,
    };
  }

  getSymbolPerformance() {
    return Array.from(this.symbolStats.entries()).map(([symbol, stats]) => ({
      symbol,
      realized_pnl: round(stats.realizedPnl),
      net_contracts: Number(stats.netContracts.toFixed(4)),
      avg_entry_price: round(stats.avgEntryPrice),
      total_volume: Number(stats.totalVolume.toFixed(4)),
      wins: stats.wins ?? 0,
      losses: stats.losses ?? 0,
      breakeven: stats.breakeven ?? 0,
      trades: stats.trades ?? 0,
      win_rate:
        stats.trades && stats.trades > 0 ? round((stats.wins / stats.trades) * 100, 2) : 0,
      last_updated: stats.lastUpdated,
    }));
  }

  getWinStats() {
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let trades = 0;

    for (const stats of this.symbolStats.values()) {
      wins += stats.wins ?? 0;
      losses += stats.losses ?? 0;
      breakeven += stats.breakeven ?? 0;
      trades += stats.trades ?? 0;
    }

    const winRate = trades > 0 ? round((wins / trades) * 100, 2) : 0;

    return { wins, losses, breakeven, trades, winRate };
  }

  getRecentSignals(limit = 5) {
    return this.signals.slice(-limit).reverse();
  }

  rehydrate(events = []) {
    for (const event of events) {
      if (!event || typeof event !== 'object') {
        continue;
      }
      const { type, data } = event;
      if (!type) continue;
      if (type === 'signal' && data) {
        this.signals.push(data);
        if (this.signals.length > this.maxEntries) {
          this.signals = this.signals.slice(-this.maxEntries);
        }
      } else if (type === 'equity' && data) {
        if (typeof data.baseline === 'number' && Number.isFinite(data.baseline)) {
          this.baselineEquity = data.baseline;
        }
        const entry = {
          balance: Number(data.balance ?? 0),
          equity: Number(data.equity ?? 0),
          pnlPercent: Number(data.pnlPercent ?? 0),
          timestamp: data.timestamp ?? new Date().toISOString(),
        };
        this.equitySnapshots.push(entry);
        if (this.equitySnapshots.length > this.maxEntries) {
          this.equitySnapshots = this.equitySnapshots.slice(-this.maxEntries);
        }
      } else if (type === 'execution' && data?.symbol) {
        this.symbolStats.set(data.symbol, {
          netContracts: Number(data.netContracts ?? 0),
          avgEntryPrice: Number(data.avgEntryPrice ?? 0),
          realizedPnl: Number(data.realizedPnl ?? 0),
          totalVolume: Number(data.totalVolume ?? 0),
          wins: Number(data.wins ?? 0),
          losses: Number(data.losses ?? 0),
          breakeven: Number(data.breakeven ?? 0),
          trades: Number(data.trades ?? 0),
          lastUpdated: data.lastUpdated ?? new Date().toISOString(),
        });
      } else if (type === 'openai_usage' && data) {
        this.openAiUsage = deserializeOpenAiUsage(data);
      }
    }
    if (this.signals.length > this.maxEntries) {
      this.signals = this.signals.slice(-this.maxEntries);
    }
    if (this.equitySnapshots.length > this.maxEntries) {
      this.equitySnapshots = this.equitySnapshots.slice(-this.maxEntries);
    }
  }
}

export const analyticsStore = new AnalyticsStore();
