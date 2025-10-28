# Day Trading Guide (English Translation)

## 1. Overview and Basic Assumptions

### 1-1. What is Day Trading?
Day trading is the practice of opening and closing positions within the same trading day — buying and then selling (or selling then buying) before the market closes. Unlike long-term investing, day trading seeks to profit from intraday price volatility.

This approach relies on capturing opportunities from price swings during the day. However, when volatility is low or market liquidity is poor, day trading opportunities are limited.

### 1-2. Core Assumptions and Preconditions
- Entry, exit, and stop-loss rules must be clearly defined for each strategy.
- Strategies must be applied with awareness of market regime (trending, ranging, news events, etc.). No single strategy works in all markets.
- Risk management is critical: predefine acceptable loss per trade.
- For automated systems (e.g., advanced trading systems under development), strategies should be modular and codable.


## 2. Strategy Conditions and Preparation

### 2-1. Instruments / Market Conditions
- Prefer instruments with high liquidity and cases where relative volume spikes above normal.
- Low volatility reduces day-trading opportunities.
- News or events (earnings, macro releases) can create actionable setups.

### 2-2. Technical Indicators / Chart Patterns
Common indicators:
- RSI (overbought/oversold detection)
- MACD (trend change confirmation)
- ADX (trend strength)
- Bollinger Bands (volatility)

Common chart patterns:
- Flags / bull flags
- Triangles (ascending/descending/symmetric)
- Gaps, breakouts, pullbacks

### 2-3. System Infrastructure & Automation Preparations
- Use a scanner/filter to automatically shortlist tradable symbols (liquidity + volume spike + news).
- Prepare modular functions for each strategy:
  - checkEntryConditions()
  - checkExitConditions()
  - checkStopLossConditions()
- Data sources should include real-time price, volume, news filters, and computed indicator values.
- Track per-strategy metrics: win rate, risk/reward ratio, max drawdown.


## 3. Key Strategies & Automation Design

Below are strategies described in an "automation-friendly" form: module structure + condition definitions + notes.

### 3-1. Momentum Trading
Definition: Enter assets showing strong upward or downward momentum.

Automation design:
- Scanner: volume surge vs recent baseline + price jump (e.g., large intraday move) + small float or RelVol > 2.

Example checkEntryConditions():
- ADX > threshold (e.g., 25)
- RSI spike or MACD crossover

checkExitConditions():
- Momentum weakening (e.g., ADX falling)
- Target price reached or partial profit-taking

checkStopLossConditions():
- Fixed % loss from entry (e.g., -1% or -2%)

Notes:
- Risk of quick reversals post-momentum — fast exits required.
- High trade frequency → account for fees & slippage.


### 3-2. Breakout Trading
Definition: Enter when price breaks major support/resistance and a new trend forms.

Automation design:
- Scanner: break of today’s or previous day’s high/low + increased volume

checkEntryConditions():
- Price exceeds resistance and intraday volume > X * average
- Candle continues higher without immediate retracement

checkExitConditions():
- Reach next significant resistance
- Reversal candle appears

checkStopLossConditions():
- Price drops back below the breakout point

Notes:
- False breakouts are common; include volume filters and confirmation candles.


### 3-3. Pullback Trading
Definition: In an established trend, enter on a retracement that resumes the trend direction.

Automation design:
- Scanner: symbols with clear trend (moving average alignment)

checkEntryConditions():
- Price reaches moving average or trend channel lower bound and shows reversal candle

checkExitConditions():
- Previous swing high/low reached

checkStopLossConditions():
- Stop below recent swing low (for longs) or above recent swing high (for shorts)

Notes:
- If trend weakens, pullback can become trend reversal — trend-strength filters needed.


### 3-4. Gap Trading
Definition: Trade the price gap that appears at open or after news/events.

Automation design:
- Scanner: gap vs previous close > X% at open

checkEntryConditions():
- Identify breakaway or runaway gap types
- Confirm liquidity and market context

checkExitConditions():
- Gap fills or opposing momentum appears

checkStopLossConditions():
- Price crosses back past the gap origin or pre-gap price

Notes:
- High volatility → strict risk controls and slippage considerations.


### 3-5. Range Trading
Definition: Trade between support and resistance when price is ranging.

Automation design:
- Scanner: symbols with clearly defined price range over recent period

checkEntryConditions():
- Price near support + bounce with volume
- Or price near resistance + rejection

checkExitConditions():
- Target opposite range boundary

checkStopLossConditions():
- Breakout past support/resistance

Notes:
- When breakout occurs, potential for large loss — include breakout filters.


### 3-6. Price Action Trading
Definition: Focus on price movements (candlestick patterns, structure) rather than indicators.

Automation design:
- Scanner: candlestick pattern detectors (hammer, shooting star) + pattern detectors (triangles, wedges)

checkEntryConditions():
- Pattern completion followed by confirming candle

checkExitConditions():
- Target achieved or reversal candle

checkStopLossConditions():
- Pattern failure (e.g., reversal of hammer)

Notes:
- Pattern recognition false positives possible — backtesting & filtering required.


## 4. Risk Management & Trader Psychology

### 4-1. Loss Limits & Capital Preservation
- Common guideline: risk no more than 2% of account equity per trade.
- Set portfolio-level monthly or annual loss limits.
- Automation should include hard stops: daily max loss, or stop trading after N consecutive losses.

### 4-2. Trader Psychology & Discipline
- Even automated systems are subject to human intervention; have monitoring and alerts for exceptions.
- Prepare logic to pause or switch strategies when the market regime changes.

### 4-3. Performance Tracking & Iteration
Record and analyze for each strategy:
- Total trades
- Win rate (%)
- Average profit / average loss
- Risk/Reward ratio
- Max drawdown
- Correlation between strategy performance and market regime

Regular reviews (monthly/quarterly) should feed improvements.


## 5. Automation System Architecture (Tailored)

### 5-1. Strategy Module Structure
Design a base class and subclass strategies (example pseudocode):

```python
class StrategyBase:
    def __init__(self, parameters):
        ...
    def check_entry(self, data):
        ...
    def check_exit(self, data):
        ...
    def check_stoploss(self, data):
        ...
    def record_trade(self, trade_info):
        ...

# Extend per strategy:
# MomentumStrategy(StrategyBase), BreakoutStrategy(StrategyBase), etc.
```

### 5-2. Data Pipeline & Infrastructure
- Real-time price/volume/news/indicator data ingestion
- Scanner/filter module: detect candidates → alert or auto-enter
- Order execution module: place entry/exit/stop orders
- Risk module: position sizing, max-loss checks, pause conditions
- Logging & dashboard: monitor per-strategy state, metrics, and alerts

### 5-3. Strategy Switching & Adaptation Logic
- Market regime detection (e.g., ADX, ATR, Bollinger width) to enable/disable strategies
- Example: if trend strength low → enable range strategies; if trend strong → enable momentum/breakout
- News-event handlers: restrict entries or activate event strategies


## 6. Handbook Summary & Execution Checklist

### 6-1. Key Takeaways
- Success structure: strategy selection + market condition assessment + clear entry/exit/stop rules
- Even with automation: risk management, regime adaptability, and tracking/feedback are mandatory
- Include logic to halt or switch strategies when they stop working

---

This document has been translated into English and saved as `backend/docs/day_trading_guide_en.md`.

If you want, I can also:
- Add this content into a README or wiki page
- Break each strategy into code templates (skeleton modules or unit tests)
- Produce a condensed checklist file for quick operational use

Which of these would you like next?