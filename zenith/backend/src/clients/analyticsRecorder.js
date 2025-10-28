import { analyticsStore } from '../store/analyticsStore.js';

export class AnalyticsRecorder {
  async recordStrategy(decision, riskLevel, options = {}) {
    analyticsStore.addSignal(decision, riskLevel, options);
    if (decision?.usage) {
      analyticsStore.recordOpenAiUsage(decision.usage);
    }
  }

  async recordExecution(result, decision) {
    analyticsStore.addExecution(result, decision);
  }

  async recordEquity(snapshot) {
    analyticsStore.addEquity(snapshot);
  }
}
