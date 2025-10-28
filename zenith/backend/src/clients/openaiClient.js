import { config } from '../config.js';
import { buildPrompt } from '../llm/prompts.js';

const REQUEST_TIMEOUT_MS = 20_000;

const STRATEGY_SYSTEM_PROMPT = [
  'You are Zenith, an expert crypto futures trading strategist specializing in technical analysis.',
  'Return ONLY a JSON object with this exact structure, nothing else:',
  '{"symbol":"string","bias":"long|short|flat","confidence":0-1,"reasoning":"<=22 words"}',
  'Analysis Guidelines:',
  '- RSI_14: <30 oversold (bullish), >70 overbought (bearish), 30-70 neutral but trending',
  '- Change_5m_pct: >0.5% strong move, >0.8% very strong move, direction crucial',
  '- Vol_ratio: >1.2 high volume (confirms trend), >1.4 very high (strong confirmation)',
  '- Edge_score: >0.6 strong signal, >0.65 very strong signal',
  'Position Management:',
  '- Use active_position context when provided. If side is long/short and signals reverse, respond with the opposite bias to flip the trade.',
  '- If signals are weak, return flat to close the position and wait.',
  'Signal Combination Rules:',
  '- LONG bias when:',
  '  * RSI trending up (even in neutral) + positive change_5m_pct + vol_ratio > 1.2',
  '  * Edge_score > 0.65 with positive momentum',
  '  * Multiple confirmations = higher confidence',
  '- SHORT bias when:',
  '  * RSI trending down + negative change_5m_pct + vol_ratio > 1.2',
  '  * Edge_score < 0.35 with negative momentum',
  '  * Bearish divergence between price and indicators',
  '- FLAT only when truly uncertain',
  '- Confidence: 0.30-0.95, based on signal alignment strength',
  '- Must reference actual values in reasoning',
].join('\n');

const STRATEGY_JSON_SCHEMA = {
  name: 'zenith_strategy',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['bias', 'confidence', 'reasoning'],
    properties: {
      symbol: { type: 'string', minLength: 1 },
      bias: { type: 'string', enum: ['long', 'short', 'flat'] },
      confidence: {
        oneOf: [
          { type: 'number', minimum: 0, maximum: 1 },
          { type: 'string', minLength: 1 },
        ],
      },
      reasoning: { type: 'string', minLength: 1 },
    },
  },
};

const DISABLED_MODELS = new Set();

const BASE_MODEL_PIPELINE = [
  {
    id: 'gpt-5-mini',
    maxOutputTokens: 2000,
  },
  {
    id: 'gpt-5-nano',
    maxOutputTokens: 1500,
    minConfidence: 0.62,
  },
];

const PRO_MODEL_SPEC = {
  id: 'gpt-5-pro',
  maxOutputTokens: 2000,
  minConfidence: 0.6,
};

const HIGH_LEVERAGE_THRESHOLD = 10;
const HIGH_NOTIONAL_THRESHOLD = 500;

function shouldEscalateToPro(riskContext = {}) {
  if (!riskContext || typeof riskContext !== 'object') {
    return false;
  }

  const { leverage, estimatedNotional, riskLevel } = riskContext;

  if (Number.isFinite(leverage) && leverage >= HIGH_LEVERAGE_THRESHOLD) {
    return true;
  }

  if (Number.isFinite(estimatedNotional) && estimatedNotional >= HIGH_NOTIONAL_THRESHOLD) {
    return true;
  }

  if (Number.isFinite(riskLevel) && riskLevel >= 5 && Number.isFinite(leverage) && leverage >= 6) {
    return true;
  }

  return false;
}

function buildModelPipeline(riskContext) {
  const pipeline = [];

  for (const spec of BASE_MODEL_PIPELINE) {
    if (!DISABLED_MODELS.has(spec.id)) {
      pipeline.push({ ...spec });
    }
  }

  if (shouldEscalateToPro(riskContext) && !DISABLED_MODELS.has(PRO_MODEL_SPEC.id)) {
    pipeline.push({ ...PRO_MODEL_SPEC });
  }

  if (pipeline.length === 0) {
    throw new Error('No OpenAI models available for strategy request');
  }

  return pipeline;
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractUsage(data, model, finishReason) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') {
    return model ? { model, finishReason } : undefined;
  }

  const promptTokens = safeNumber(usage.prompt_tokens) ?? 0;
  const completionTokens = safeNumber(usage.completion_tokens) ?? 0;
  const totalTokens = safeNumber(usage.total_tokens) ?? (promptTokens + completionTokens);

  const inputCost = safeNumber(usage.input_cost) ?? safeNumber(usage.prompt_cost) ?? safeNumber(usage.inputCost) ?? 0;
  const outputCost =
    safeNumber(usage.output_cost) ?? safeNumber(usage.completion_cost) ?? safeNumber(usage.outputCost) ?? 0;
  const totalCost = safeNumber(usage.total_cost) ?? safeNumber(usage.totalCost) ?? inputCost + outputCost;

  return {
    model,
    finishReason,
    promptTokens,
    completionTokens,
    totalTokens,
    inputCost,
    outputCost,
    totalCost,
  };
}

function sanitizeReasoning(reasoning) {
  if (typeof reasoning !== 'string') {
    return 'No reasoning provided';
  }
  const normalized = reasoning.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'No reasoning provided';
  }
  const words = normalized.split(' ');
  if (words.length <= 22) {
    return normalized;
  }
  return `${words.slice(0, 22).join(' ')}...`;
}

function parseStrategyPayload(payload, fallbackSymbol) {
  let parsed = payload;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) {
      throw new Error('OpenAI strategy payload was empty');
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const parseError = new Error('Failed to parse OpenAI strategy JSON');
      parseError.cause = error;
      parseError.body = trimmed;
      throw parseError;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAI strategy payload was not an object');
  }

  const rawBias = typeof parsed.bias === 'string' ? parsed.bias.trim().toLowerCase() : '';
  if (!['long', 'short', 'flat'].includes(rawBias)) {
    throw new Error('Invalid bias returned from OpenAI');
  }

  let confidence = safeNumber(parsed.confidence);
  if (!Number.isFinite(confidence)) {
    const raw = typeof parsed.confidence === 'string' ? parsed.confidence.trim() : '';
    if (raw.endsWith('%')) {
      const percentValue = safeNumber(raw.slice(0, -1));
      if (Number.isFinite(percentValue)) {
        confidence = percentValue / 100;
      }
    } else {
      const numeric = safeNumber(raw);
      if (Number.isFinite(numeric)) {
        confidence = numeric;
      }
    }
  }

  if (!Number.isFinite(confidence)) {
    throw new Error('Invalid confidence returned from OpenAI');
  }

  const reasoning = sanitizeReasoning(parsed.reasoning);
  const symbol =
    typeof parsed.symbol === 'string' && parsed.symbol.trim().length > 0
      ? parsed.symbol.trim().toUpperCase()
      : fallbackSymbol;

  return {
    symbol,
    bias: rawBias,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning,
  };
}

function summarizeAttempts(attempts) {
  const summary = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    calls: 0,
    model: attempts.length > 0 ? attempts[attempts.length - 1].model : undefined,
    attempts: [],
  };

  for (const attempt of attempts) {
    summary.calls += 1;
    const usage = attempt.usage ?? {};
    const promptTokens = safeNumber(usage.prompt_tokens) ?? 0;
    const completionTokens = safeNumber(usage.completion_tokens) ?? 0;
    const totalTokens = safeNumber(usage.total_tokens) ?? promptTokens + completionTokens;
    const inputCost = safeNumber(usage.prompt_cost) ?? 0;
    const outputCost = safeNumber(usage.completion_cost) ?? 0;
    const totalCost = safeNumber(usage.total_cost) ?? inputCost + outputCost;

    summary.promptTokens += promptTokens;
    summary.completionTokens += completionTokens;
    summary.totalTokens += totalTokens;
    summary.inputCost += inputCost;
    summary.outputCost += outputCost;
    summary.totalCost += totalCost;

    summary.attempts.push({
      model: attempt.model,
      promptTokens,
      completionTokens,
      totalTokens,
      inputCost,
      outputCost,
      totalCost,
      finishReason: usage.finishReason,
      disposition: attempt.disposition,
      error: attempt.error,
    });
  }

  return summary;
}

function buildRequestHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openAi.apiKey}`,
  };
}

function buildChatBody(prompt, spec) {
  return {
    model: spec.id,
    messages: [
      { role: 'system', content: STRATEGY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    max_completion_tokens: spec.maxOutputTokens,
    metadata: {
      application: 'zenith-trader',
      intent: 'strategy',
    },
  };
}

function buildResponsesBody(prompt, spec) {
  return {
    model: spec.id,
    input: [
      { role: 'system', content: STRATEGY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    max_output_tokens: spec.maxOutputTokens,
    metadata: {
      application: 'zenith-trader',
      intent: 'strategy',
    },
  };
}

function extractFinishReason(data) {
  const firstChoice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  if (firstChoice?.finish_reason || firstChoice?.message?.finish_reason) {
    return firstChoice.finish_reason ?? firstChoice.message.finish_reason;
  }

  const firstOutput = Array.isArray(data?.output) ? data.output[0] : undefined;
  return firstOutput?.finish_reason ?? firstOutput?.metadata?.finish_reason;
}

function extractPayload(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const choice = choices[0];
  if (choice) {
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      const cleaned = content.trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/```\s*$/, '');
      return cleaned;
    }
  }

  const outputs = Array.isArray(data?.output) ? data.output : [];
  for (const output of outputs) {
    const contentParts = Array.isArray(output?.content) ? output.content : [];
    for (const part of contentParts) {
      const text = typeof part?.text === 'string' ? part.text : part?.content;
      if (typeof text === 'string' && text.trim()) {
        const cleaned = text.trim()
          .replace(/^```(?:json)?\s*/, '')
          .replace(/```\s*$/, '');
        if (cleaned) {
          return cleaned;
        }
      }
    }
  }

  return undefined;
}

async function performOpenAiRequest({ url, body, controller }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: buildRequestHeaders(),
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  const raw = await response.text();
  let data;
  try {
    data = raw.length > 0 ? JSON.parse(raw) : {};
  } catch (error) {
    const parseError = new Error('Failed to parse OpenAI response payload');
    parseError.cause = error;
    parseError.body = raw;
    throw parseError;
  }

  if (!response.ok) {
    const message =
      typeof data?.error?.message === 'string'
        ? `OpenAI responded with status ${response.status}: ${data.error.message}`
        : `OpenAI responded with status ${response.status}`;
    const error = new Error(message);
    error.body = data;
    error.status = response.status;
    throw error;
  }

  return data;
}

function shouldFallbackToChat(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const bodyMessage = typeof error?.body?.error?.message === 'string' ? error.body.error.message.toLowerCase() : '';

  return message.includes('only supported in v1/chat/completions') || bodyMessage.includes('v1/chat/completions');
}

function shouldFallbackToResponses(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const bodyMessage = typeof error?.body?.error?.message === 'string' ? error.body.error.message.toLowerCase() : '';

  return message.includes('only supported in v1/responses') || bodyMessage.includes('v1/responses');
}

async function callOpenAi(prompt, spec) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const responsesRequest = {
    url: 'https://api.openai.com/v1/responses',
    body: buildResponsesBody(prompt, spec),
    controller,
  };

  const chatRequest = {
    url: 'https://api.openai.com/v1/chat/completions',
    body: buildChatBody(prompt, spec),
    controller,
  };

  try {
    let data;

    try {
      data = await performOpenAiRequest(responsesRequest);
    } catch (error) {
      if (shouldFallbackToChat(error)) {
        data = await performOpenAiRequest(chatRequest);
      } else {
        throw error;
      }
    }

    const finishReason = extractFinishReason(data);
    const usage = extractUsage(data, spec.id, finishReason);
    const payload = extractPayload(data);

    if (payload === undefined) {
      const error = new Error('OpenAI response did not include strategy content');
      error.body = data;
      throw error;
    }

    return { payload, usage };
  } catch (error) {
    if (shouldFallbackToResponses(error)) {
      try {
        const data = await performOpenAiRequest(responsesRequest);
        const finishReason = extractFinishReason(data);
        const usage = extractUsage(data, spec.id, finishReason);
        const payload = extractPayload(data);

        if (payload === undefined) {
          const missingError = new Error('OpenAI response did not include strategy content');
          missingError.body = data;
          throw missingError;
        }

        return { payload, usage };
      } catch (fallbackError) {
        if (fallbackError.name === 'AbortError') {
          const timeoutError = new Error(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`);
          timeoutError.cause = fallbackError;
          throw timeoutError;
        }
        throw fallbackError;
      }
    }

    if (error.name === 'AbortError') {
      const timeoutError = new Error(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestStrategy(symbol, marketContext, riskContext = {}) {
  const prompt = buildPrompt(symbol, marketContext);
  const attempts = [];
  let lastError;

  let pipeline;
  try {
    pipeline = buildModelPipeline(riskContext);
  } catch (error) {
    lastError = error;
    pipeline = [];
  }

  // Iterate by index so we can remove models from the pipeline dynamically
  // if they are reported as nonexistent by the API. This avoids repeatedly
  // calling the same unavailable model for each symbol.
  let i = 0;
  while (i < pipeline.length) {
    const spec = pipeline[i];
    let attemptUsage;
    try {
      const { payload, usage } = await callOpenAi(prompt, spec);
      attemptUsage = usage;
      const strategy = parseStrategyPayload(payload, symbol);
      strategy.model = spec.id;

      const guardBreached = spec.minConfidence !== undefined && strategy.confidence < spec.minConfidence;
      attempts.push({
        model: spec.id,
        usage,
        disposition: guardBreached ? 'below_guard' : 'accepted',
      });

      if (guardBreached) {
        lastError = new Error(
          `Model ${spec.id} returned low confidence ${strategy.confidence.toFixed(2)} (< ${spec.minConfidence.toFixed(2)})`
        );
        i += 1;
        continue;
      }

      const usageSummary = summarizeAttempts(attempts);
      usageSummary.model = strategy.model;
      strategy.usage = usageSummary;
      return strategy;
    } catch (error) {
      attempts.push({
        model: spec.id,
        usage: attemptUsage,
        disposition: 'error',
        error: error.message,
      });
      lastError = error;

      // If the API reports the model does not exist, remove it from the
      // pipeline so subsequent evaluations don't repeatedly hit the same
      // error for every symbol.
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes("does not exist") || msg.includes('model') && msg.includes('does not exist')) {
        // Log to console; other parts of the app use the centralized logger,
        // but console is acceptable here to keep the client lightweight.
        // eslint-disable-next-line no-console
        console.warn(`OpenAI model not found, removing from pipeline: ${spec.id}`);
        DISABLED_MODELS.add(spec.id);
        pipeline.splice(i, 1);
        // don't increment i so we try the next element that shifted into this index
        continue;
      }

      // Otherwise move to the next model in the pipeline
      i += 1;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('Failed to obtain strategy from OpenAI');
}


