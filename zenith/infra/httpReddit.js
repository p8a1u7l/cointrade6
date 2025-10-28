import axios from 'axios';
import http from 'node:http';
import https from 'node:https';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfterMs(res) {
  const headerValue = res?.headers?.['retry-after'];
  if (!headerValue) return null;
  const asNumber = Number(headerValue);
  if (!Number.isNaN(asNumber)) return asNumber * 1000;
  const parsed = Date.parse(headerValue);
  return Number.isNaN(parsed) ? null : Math.max(parsed - Date.now(), 0);
}

export const redditHTTP = axios.create({
  timeout: Number(process.env.REDDIT_TIMEOUT_MS ?? 15_000),
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': process.env.REDDIT_UA ?? 'zenith-bot/1.0 (by u/yourusername)',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br',
  },
  family: 4,
});

redditHTTP.interceptors.request.use((cfg) => {
  cfg.metadata = { start: Date.now() };
  return cfg;
});

redditHTTP.interceptors.response.use((res) => {
  if (res.config?.metadata?.start) {
    const duration = Date.now() - res.config.metadata.start;
    if (duration > 5000) {
      console.warn(`[reddit] slow response ${duration}ms ${res.config.url}`);
    }
  }
  return res;
});

export async function getWithRetry(
  url,
  { params, headers, maxRetries = 4, baseBackoff = 1500 } = {}
) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await redditHTTP.get(url, { params, headers });
    } catch (error) {
      const status = error?.response?.status;
      const code = error?.code;
      const retriableStatus = [429, 500, 502, 503, 504].includes(status);
      const retriableCode = ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN'].includes(
        code
      );

      if (!(retriableStatus || retriableCode) || attempt >= maxRetries) {
        throw error;
      }

      const retryAfter = parseRetryAfterMs(error?.response);
      const backoff =
        (retryAfter ?? Math.min(20_000, baseBackoff * 2 ** attempt)) +
        Math.floor(Math.random() * 400);
      console.warn(
        `[reddit] retry ${attempt + 1}/${maxRetries} after ${backoff}ms for ${url} (status=${
          status || code
        })`
      );
      await sleep(backoff);
      attempt += 1;
    }
  }
}
