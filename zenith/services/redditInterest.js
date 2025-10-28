import pLimit from 'p-limit';
import { fetchSubredditSafe } from '../sources/redditFeed.js';

const limit = pLimit(Number(process.env.REDDIT_CONCURRENCY ?? 3));
const MIN_INTERVAL_MS = Number(process.env.REDDIT_MIN_INTERVAL_MS ?? 300_000);
const BREAKER_TRIP = Number(process.env.REDDIT_TRIP_COUNT ?? 3);
const BREAKER_SLEEP_MS = Number(process.env.REDDIT_TRIP_SLEEP_MS ?? 900_000);
const TTL_MS = Number(process.env.REDDIT_TTL_MS ?? 600_000);

let lastRun = 0;
let running = false;
let consecutiveTimeouts = 0;
let breakerUntil = 0;
const cache = new Map();

export async function refreshReddit(
  subreddits = ['Cryptocurrency', 'ethtrader']
) {
  const now = Date.now();
  if (now < breakerUntil) return readCache(subreddits);
  if (running) return readCache(subreddits);
  if (now - lastRun < MIN_INTERVAL_MS) return readCache(subreddits);

  running = true;
  lastRun = now;

  try {
    const tasks = subreddits.map((sub) =>
      limit(async () => {
        const items = await fetchSubredditSafe(sub, { sort: 'new', limit: 50 });
        cache.set(sub, { ts: Date.now(), items });
        return items;
      })
    );
    const settled = await Promise.allSettled(tasks);
    const all = settled.map((result) => (result.status === 'fulfilled' ? result.value : []));
    consecutiveTimeouts = 0;
    return flattenOrCache(all, subreddits);
  } catch (error) {
    const code = error?.code;
    if (['ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) {
      consecutiveTimeouts += 1;
      if (consecutiveTimeouts >= BREAKER_TRIP) {
        breakerUntil = Date.now() + BREAKER_SLEEP_MS;
        console.warn(
          `[reddit] breaker tripped until ${new Date(breakerUntil).toISOString()}`
        );
      }
    }
    return readCache(subreddits);
  } finally {
    running = false;
  }
}

function readCache(subreddits) {
  const now = Date.now();
  const result = [];
  for (const sub of subreddits) {
    const entry = cache.get(sub);
    if (entry && now - entry.ts < TTL_MS) {
      result.push(...entry.items);
    }
  }
  return result;
}

function flattenOrCache(all, subs) {
  if (!all.length) return readCache(subs);
  return all.flat();
}
