import { getWithRetry } from '../infra/httpReddit.js';
import { parseStringPromise } from 'xml2js';

function mapRedditListing(json) {
  const children = json?.data?.children ?? [];
  return children.map((child) => {
    const data = child?.data ?? {};
    return {
      id: data.id,
      title: data.title,
      url: `https://www.reddit.com${data.permalink ?? ''}`,
      created_utc: data.created_utc,
      author: data.author,
      score: data.score,
      num_comments: data.num_comments,
      subreddit: data.subreddit,
    };
  });
}

async function fetchJson(subreddit, { sort = 'new', limit = 50, t } = {}) {
  const url = `https://www.reddit.com/r/${subreddit}/${sort}.json`;
  const params = { limit, raw_json: 1 };
  if (t) params.t = t;
  const res = await getWithRetry(url, { params });
  return mapRedditListing(res.data);
}

async function fetchRssFallback(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/new.rss`;
  const res = await getWithRetry(url);
  const rss = await parseStringPromise(res.data, { explicitArray: false });
  const entries = rss?.feed?.entry;
  const items = Array.isArray(entries) ? entries : entries ? [entries] : [];
  return items.map((entry) => ({
    id: entry?.id,
    title: entry?.title,
    url: entry?.link?.['@_href'] || entry?.link?.href || entry?.link,
    created_utc: entry?.updated ? Math.floor(new Date(entry.updated).getTime() / 1000) : undefined,
    author: entry?.author?.name ?? entry?.author ?? undefined,
    score: undefined,
    num_comments: undefined,
    subreddit,
  }));
}

export async function fetchSubredditSafe(subreddit, opts = {}) {
  try {
    return await fetchJson(subreddit, opts);
  } catch (error) {
    console.warn(
      `[reddit] JSON failed for r/${subreddit}, fallback to RSS: ${error?.message || error}`
    );
    try {
      return await fetchRssFallback(subreddit);
    } catch (fallbackError) {
      console.warn(
        `[reddit] RSS fallback failed for r/${subreddit}: ${
          fallbackError?.message || fallbackError
        }`
      );
      return [];
    }
  }
}
