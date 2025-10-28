export type TradingSession = "ASIA" | "LONDON" | "NY" | "BRIDGE";

export function sessionOf(ts: number): TradingSession {
  const date = new Date(ts);
  const hour = date.getUTCHours();

  if (hour >= 0 && hour < 7) {
    return "ASIA";
  }
  if (hour >= 7 && hour < 11) {
    return "BRIDGE";
  }
  if (hour >= 11 && hour < 16) {
    return "LONDON";
  }
  return "NY";
}
