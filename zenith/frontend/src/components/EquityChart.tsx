import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Area as RechartsArea,
  AreaChart as RechartsAreaChart,
  CartesianGrid as RechartsCartesianGrid,
  ResponsiveContainer as RechartsResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis as RechartsXAxis,
  YAxis as RechartsYAxis,
} from 'recharts';

type AnyComponent = (props: any) => ReactNode;

const AreaChart = RechartsAreaChart as unknown as AnyComponent;
const Area = RechartsArea as unknown as AnyComponent;
const CartesianGrid = RechartsCartesianGrid as unknown as AnyComponent;
const ResponsiveContainer = RechartsResponsiveContainer as unknown as AnyComponent;
const Tooltip = RechartsTooltip as unknown as AnyComponent;
const XAxis = RechartsXAxis as unknown as AnyComponent;
const YAxis = RechartsYAxis as unknown as AnyComponent;

interface EquityPoint {
  timestamp: string;
  equity: number;
  balance: number;
  pnlPercent: number;
}

interface EquitySeriesResponse {
  points: EquityPoint[];
  message?: string;
}

interface EquityChartProps {
  endpoint: string;
  refreshIntervalMs?: number;
}

interface ChartPoint {
  timestamp: string;
  label: string;
  equity: number;
  balance: number;
  pnlPercent: number;
}

const formatUsd = (value: number, digits: number | undefined = 2) =>
  Number.isFinite(value)
    ? value.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : '—';

const formatTime = (timestamp: string) => {
  try {
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch (_error) {
    return timestamp;
  }
};

function TooltipContent({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;
  const pnlPercent = Number.isFinite(point.pnlPercent) ? point.pnlPercent : 0;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/90 px-3 py-2 text-xs text-slate-200 shadow-lg">
      <div className="font-semibold text-white">{point.label}</div>
      <div className="mt-1 text-[11px] text-slate-300/80">
        Equity {formatUsd(point.equity)}
      </div>
      <div className="text-[11px] text-slate-300/70">Balance {formatUsd(point.balance)}</div>
      <div className="text-[11px] text-slate-300/70">
        Change {pnlPercent >= 0 ? '+' : ''}
        {pnlPercent.toFixed(2)}%
      </div>
    </div>
  );
}

export function EquityChart({ endpoint, refreshIntervalMs = 5000 }: EquityChartProps) {
  const [points, setPoints] = useState<EquityPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function load() {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`Equity request failed: ${response.status}`);
        }
        const payload = (await response.json()) as EquitySeriesResponse;
        if (!cancelled) {
          setPoints(Array.isArray(payload.points) ? payload.points : []);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load equity data');
          setLoading(false);
        }
      }
    }

    void load();
    timer = setInterval(load, refreshIntervalMs);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [endpoint, refreshIntervalMs]);

  const chartPoints = useMemo<ChartPoint[]>(() => {
    return points
      .map((point) => {
        const date = new Date(point.timestamp);
        return {
          timestamp: point.timestamp,
          label: formatTime(point.timestamp),
          equity: Number(point.equity),
          balance: Number(point.balance),
          pnlPercent: Number(point.pnlPercent),
          sortKey: Number.isFinite(date.getTime()) ? date.getTime() : 0,
        };
      })
      .filter((point) => Number.isFinite(point.equity) && Number.isFinite(point.sortKey))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ sortKey: _sortKey, ...rest }) => ({
        ...rest,
        pnlPercent: Number.isFinite(rest.pnlPercent) ? rest.pnlPercent : 0,
      }));
  }, [points]);

  const latestPoint = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1] : null;
  const earliestPoint = chartPoints.length > 0 ? chartPoints[0] : null;

  const changePct = useMemo(() => {
    if (!earliestPoint || !latestPoint) return 0;
    const start = earliestPoint.equity;
    const end = latestPoint.equity;
    if (!Number.isFinite(start) || start === 0) return 0;
    return ((end - start) / start) * 100;
  }, [earliestPoint, latestPoint]);

  const peak = useMemo(() => {
    if (chartPoints.length === 0) return 0;
    return chartPoints.reduce((max, point) => (point.equity > max ? point.equity : max), chartPoints[0].equity);
  }, [chartPoints]);

  const trough = useMemo(() => {
    if (chartPoints.length === 0) return 0;
    return chartPoints.reduce((min, point) => (point.equity < min ? point.equity : min), chartPoints[0].equity);
  }, [chartPoints]);

  return (
    <div className="space-y-4 rounded-3xl border border-white/10 bg-slate-950/70 p-6 shadow-[0_30px_70px_-55px_rgba(14,165,233,0.45)]">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-white">Equity balance</h2>
          {latestPoint && (
            <p className="text-sm text-slate-300/80">
              Latest {formatUsd(latestPoint.equity)} · Session change {changePct >= 0 ? '+' : ''}
              {changePct.toFixed(2)}% · Updated {formatTime(latestPoint.timestamp)}
            </p>
          )}
        </div>
        {earliestPoint && latestPoint && (
          <div className="grid grid-cols-2 gap-3 text-xs text-slate-300/80 sm:grid-cols-4">
            <div>
              <span className="block text-[0.7rem] uppercase tracking-[0.35em] text-slate-400/60">Opening</span>
              <span className="text-sm font-semibold text-white">{formatUsd(earliestPoint.equity)}</span>
            </div>
            <div>
              <span className="block text-[0.7rem] uppercase tracking-[0.35em] text-slate-400/60">Peak</span>
              <span className="text-sm font-semibold text-emerald-200">{formatUsd(peak)}</span>
            </div>
            <div>
              <span className="block text-[0.7rem] uppercase tracking-[0.35em] text-slate-400/60">Drawdown</span>
              <span className="text-sm font-semibold text-rose-200">{formatUsd(trough)}</span>
            </div>
            <div>
              <span className="block text-[0.7rem] uppercase tracking-[0.35em] text-slate-400/60">Points</span>
              <span className="text-sm font-semibold text-white">{chartPoints.length}</span>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="h-[360px] w-full animate-pulse rounded-2xl bg-slate-800/40" />
      ) : error ? (
        <div className="flex h-[360px] items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-500/10 text-sm text-rose-100">
          {error}
        </div>
      ) : chartPoints.length < 2 ? (
        <div className="flex h-[360px] items-center justify-center rounded-2xl border border-white/10 bg-slate-900/60 text-sm text-slate-300/70">
          Not enough equity history yet.
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-b from-slate-900/60 to-slate-950/90 px-2 py-2">
          <ResponsiveContainer width="100%" height={340}>
            <AreaChart data={chartPoints} margin={{ left: 12, right: 12, top: 12, bottom: 0 }}>
              <defs>
                <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="rgba(56,189,248,0.85)" stopOpacity={0.9} />
                  <stop offset="95%" stopColor="rgba(56,189,248,0.1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={32}
                tick={{ fill: 'rgba(226,232,240,0.7)', fontSize: 12 }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => formatUsd(value, 0)}
                tick={{ fill: 'rgba(226,232,240,0.7)', fontSize: 12 }}
              />
              <Tooltip content={<TooltipContent />} cursor={{ stroke: 'rgba(148,163,184,0.2)', strokeWidth: 1 }} />
              <Area
                type="monotone"
                dataKey="equity"
                stroke="rgba(56,189,248,0.95)"
                strokeWidth={2.4}
                fill="url(#equityGradient)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
          {latestPoint && (
            <div className="pointer-events-none absolute right-4 top-4 rounded-full bg-slate-900/80 px-3 py-1 text-xs font-semibold text-sky-100 ring-1 ring-sky-400/40">
              {formatUsd(latestPoint.equity)} · {formatTime(latestPoint.timestamp)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
