import clsx from 'clsx';
import { useEffect, useState } from 'react';

interface Props {
  riskLevel: number;
  onRiskChange: (level: number) => void;
  running: boolean;
  signalsEndpoint: string;
  leverage: number;
  allocationPct: number;
  onLeverageChange: (value: number) => void;
  onAllocationChange: (value: number) => void;
}

interface SignalRow {
  created_at: string;
  symbol: string;
  bias: string;
  confidence: number;
  risk_level: number;
}

type RangeChangeEvent = { target: { value: string } };
type RangeKeyboardEvent = { key: string };

const riskLabels = {
  1: 'Capital preservation',
  2: 'Cautious',
  3: 'Balanced',
  4: 'Aggressive',
  5: 'High octane',
};

export function ControlPanel({
  riskLevel,
  onRiskChange,
  running,
  signalsEndpoint,
  leverage,
  allocationPct,
  onLeverageChange,
  onAllocationChange,
}: Props) {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [pendingLeverage, setPendingLeverage] = useState(leverage);
  const [pendingAllocation, setPendingAllocation] = useState(allocationPct);

  useEffect(() => {
    if (!signalsEndpoint) return;
    let ignore = false;

    const fetchSignals = async () => {
      try {
        const response = await fetch(signalsEndpoint);
        if (!response.ok) throw new Error(`Failed to fetch signals: ${response.status}`);
        const payload = (await response.json()) as SignalRow[];
        if (!ignore) {
          setSignals(payload.slice(0, 5));
        }
      } catch (error) {
        console.error('Failed to load signals', error);
      }
    };

    void fetchSignals();
    const interval = setInterval(fetchSignals, 5000);

    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [signalsEndpoint]);

  useEffect(() => {
    setPendingLeverage(leverage);
  }, [leverage]);

  useEffect(() => {
    setPendingAllocation(allocationPct);
  }, [allocationPct]);

  const commitLeverage = () => {
    const rounded = Math.round(pendingLeverage);
    if (rounded !== Math.round(leverage)) {
      onLeverageChange(rounded);
    }
  };

  const commitAllocation = () => {
    const rounded = Math.round(pendingAllocation);
    if (rounded !== Math.round(allocationPct)) {
      onAllocationChange(rounded);
    }
  };

  return (
    <div className="space-y-8 rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_35px_120px_-65px_rgba(59,130,246,0.7)] backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Risk orchestration</h2>
          <p className="mt-1 text-sm text-slate-300/90">Dial in exposure presets tuned for GPT-driven execution.</p>
        </div>
        <span
          className={clsx(
            'rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide',
            running ? 'bg-emerald-400/15 text-emerald-200' : 'bg-rose-400/10 text-rose-200'
          )}
        >
          {running ? 'Running' : 'Paused'}
        </span>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {[1, 2, 3, 4, 5].map((level) => (
          <button
            key={level}
            className={clsx(
              'relative overflow-hidden rounded-2xl border px-0 py-3 text-sm font-semibold transition',
              level === riskLevel
                ? 'border-emerald-400/70 bg-gradient-to-br from-emerald-400/30 via-emerald-500/20 to-teal-400/10 text-emerald-100 shadow-[0_12px_40px_-20px_rgba(16,185,129,0.8)]'
                : 'border-white/10 bg-slate-950/40 text-slate-200 hover:border-emerald-300/60 hover:text-emerald-100'
            )}
            onClick={() => onRiskChange(level)}
          >
            <span className="text-lg">{level}</span>
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-5 py-4">
        <div className="text-sm font-medium text-white">{riskLabels[riskLevel as keyof typeof riskLabels]}</div>
        <div className="mt-1 text-sm text-slate-300/90">Engine cadence aligns leverage and order sizing with this profile.</div>
      </div>

      <div className="space-y-6 rounded-2xl border border-white/10 bg-slate-950/50 px-5 py-4">
        <div>
          <div className="flex items-center justify-between text-sm font-medium text-white">
            <span>Leverage multiplier</span>
            <span className="rounded-full border border-emerald-300/40 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">
              x{Math.round(pendingLeverage)}
            </span>
          </div>
          <input
            className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-800/80 accent-emerald-400"
            type="range"
            min={1}
            max={50}
            step={1}
            value={pendingLeverage}
            onChange={(event: RangeChangeEvent) => setPendingLeverage(Number(event.target.value))}
            onPointerUp={commitLeverage}
            onKeyUp={(event: RangeKeyboardEvent) => {
              if (['Enter', ' ', 'Spacebar', 'ArrowLeft', 'ArrowRight'].includes(event.key)) commitLeverage();
            }}
          />
          <p className="mt-2 text-xs text-slate-400/90">
            GPT execution defaults to GPT-mini and escalates only on high-risk runs. Use leverage judiciously when capital is at
            stake.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm font-medium text-white">
            <span>Allocation per trade</span>
            <span className="rounded-full border border-cyan-300/40 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-200">
              {Math.round(pendingAllocation)}%
            </span>
          </div>
          <input
            className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-800/80 accent-cyan-400"
            type="range"
            min={1}
            max={100}
            step={1}
            value={pendingAllocation}
            onChange={(event: RangeChangeEvent) => setPendingAllocation(Number(event.target.value))}
            onPointerUp={commitAllocation}
            onKeyUp={(event: RangeKeyboardEvent) => {
              if (['Enter', ' ', 'Spacebar', 'ArrowLeft', 'ArrowRight'].includes(event.key)) commitAllocation();
            }}
          />
          <p className="mt-2 text-xs text-slate-400/90">
            Set how much available margin GPT can deploy per trade. The engine still enforces Binance filters and margin guard
            rails.
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold text-white">Latest LLM directives</h3>
        <div className="mt-3 space-y-3">
          {signals.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-slate-400">
              Awaiting signals...
            </div>
          )}
          {signals.map((signal) => (
            <div
              key={signal.created_at}
              className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 shadow-[0_18px_45px_-35px_rgba(14,116,144,0.8)]"
            >
              <div className="flex items-center justify-between text-sm text-white">
                <div className="font-semibold">{signal.symbol}</div>
                <div
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
                    signal.bias === 'long' ? 'bg-emerald-400/15 text-emerald-200' : 'bg-rose-400/15 text-rose-200'
                  )}
                >
                  {signal.bias}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between text-xs text-slate-300/90">
                <span>{new Date(signal.created_at).toLocaleTimeString()}</span>
                <span>Risk {signal.risk_level}</span>
                <span>{Math.round(signal.confidence * 100)}% confidence</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
