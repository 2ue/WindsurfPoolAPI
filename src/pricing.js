/**
 * Model pricing cache.
 *
 * Source: LiteLLM's open-source model pricing table. Values are USD/token.
 * Local cache is intentionally runtime data (model-prices.json, ignored by git)
 * so startup still works if GitHub is unreachable.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config, log } from './config.js';
import { MODELS } from './models.js';

const PRICING_FILE = join(process.cwd(), 'model-prices.json');
export const DEFAULT_PRICE_SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICE_SOURCE_URL = process.env.PRICE_SOURCE_URL || DEFAULT_PRICE_SOURCE_URL;
const PRICE_SYNC_TIMEOUT_MS = Math.max(1000, Number(process.env.PRICE_SYNC_TIMEOUT_MS || 15000));

const _state = {
  sourceUrl: PRICE_SOURCE_URL,
  source: 'LiteLLM model_prices_and_context_window.json',
  fetchedAt: 0,
  modelCount: 0,
  lastError: '',
  prices: {},
};

loadFromDisk();

function atomicWrite(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function loadFromDisk() {
  try {
    if (!existsSync(PRICING_FILE)) return;
    const raw = JSON.parse(readFileSync(PRICING_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object') return;
    Object.assign(_state, {
      sourceUrl: raw.sourceUrl || PRICE_SOURCE_URL,
      source: raw.source || _state.source,
      fetchedAt: raw.fetchedAt || 0,
      modelCount: raw.modelCount || Object.keys(raw.prices || {}).length,
      lastError: raw.lastError || '',
      prices: raw.prices || {},
    });
  } catch (err) {
    _state.lastError = `读取本地价格缓存失败: ${err.message}`;
  }
}

function saveToDisk() {
  try {
    atomicWrite(PRICING_FILE, JSON.stringify(_state, null, 2));
  } catch (err) {
    log.warn(`Pricing cache save failed: ${err.message}`);
  }
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pickPrice(raw, key) {
  const input = numberOrNull(raw.input_cost_per_token);
  const output = numberOrNull(raw.output_cost_per_token);
  if (input == null && output == null) return null;
  return {
    model: key,
    provider: raw.litellm_provider || raw.provider || '',
    mode: raw.mode || '',
    currency: 'USD',
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: numberOrNull(raw.cache_read_input_token_cost),
    cacheWriteCostPerToken: numberOrNull(raw.cache_creation_input_token_cost),
    maxInputTokens: numberOrNull(raw.max_input_tokens),
    maxOutputTokens: numberOrNull(raw.max_output_tokens),
  };
}

function normalisePriceTable(raw) {
  const prices = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!value || typeof value !== 'object') continue;
    const p = pickPrice(value, key);
    if (p) prices[key] = p;
  }
  return prices;
}

export function initPricing() {
  if (config.priceSyncOnStartup) {
    syncModelPrices().catch(err => log.warn(`Pricing startup sync failed: ${err.message}`));
  }
}

export async function syncModelPrices() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(PRICE_SOURCE_URL, {
      headers: { 'Accept': 'application/json,text/plain,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const prices = normalisePriceTable(raw);
    if (Object.keys(prices).length < 100) {
      throw new Error(`价格表数量异常: ${Object.keys(prices).length}`);
    }
    Object.assign(_state, {
      sourceUrl: PRICE_SOURCE_URL,
      source: 'LiteLLM model_prices_and_context_window.json',
      fetchedAt: Date.now(),
      modelCount: Object.keys(prices).length,
      lastError: '',
      prices,
    });
    saveToDisk();
    log.info(`Pricing synced: ${_state.modelCount} models from ${PRICE_SOURCE_URL}`);
    return getPricingSnapshot();
  } catch (err) {
    _state.lastError = err.name === 'AbortError' ? '价格同步超时' : err.message;
    saveToDisk();
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function addCandidate(list, value) {
  const s = String(value || '').trim();
  if (!s) return;
  if (!list.includes(s)) list.push(s);
  const lower = s.toLowerCase();
  if (!list.includes(lower)) list.push(lower);
}

function withNumericDotsAsDashes(s) {
  return String(s || '').replace(/(\d)\.(\d)/g, '$1-$2');
}

function stripRoutingSuffixes(s) {
  return String(s || '')
    .replace(/-thinking(?=-|$)/g, '')
    .replace(/-(low|medium|high|xhigh|max)(?=-|$)/g, '')
    .replace(/-fast(?=-|$)/g, '');
}

function modelCandidates(model) {
  const candidates = [];
  const info = MODELS[model] || MODELS[String(model || '').toLowerCase()];
  addCandidate(candidates, model);
  addCandidate(candidates, info?.name);
  addCandidate(candidates, info?.modelUid);

  const baseInputs = [...candidates];
  for (const value of baseInputs) {
    const dashed = withNumericDotsAsDashes(value);
    addCandidate(candidates, dashed);
    addCandidate(candidates, stripRoutingSuffixes(dashed));
    addCandidate(candidates, stripRoutingSuffixes(value));
    addCandidate(candidates, dashed.replace(/^claude-(\d+)-(\d+)-(haiku|sonnet|opus)$/, 'claude-$3-$1-$2'));
    addCandidate(candidates, dashed.replace(/^claude-(\d+)-(haiku|sonnet|opus)$/, 'claude-$2-$1'));
  }

  // Known Windsurf/Claude aliases where internal catalog order differs from
  // public model names used by pricing tables.
  const aliases = {
    'claude-4-sonnet': 'claude-sonnet-4-20250514',
    'claude-4-opus': 'claude-opus-4-20250514',
    'claude-4-1-opus': 'claude-opus-4-1',
    'claude-4-5-haiku': 'claude-haiku-4-5',
    'claude-4-5-sonnet': 'claude-sonnet-4-5',
    'claude-4-5-opus': 'claude-opus-4-5',
  };
  for (const value of [...candidates]) {
    const stripped = stripRoutingSuffixes(withNumericDotsAsDashes(value));
    if (aliases[stripped]) addCandidate(candidates, aliases[stripped]);
  }

  // Provider-prefixed variants in LiteLLM (Bedrock/Azure/etc.) are not used
  // for cost selection unless the caller explicitly requested that key.
  return candidates;
}

export function findModelPrice(model) {
  for (const c of modelCandidates(model)) {
    const price = _state.prices[c];
    if (price) return price;
  }
  return null;
}

export function calculateUsageCost(model, tokens) {
  const price = findModelPrice(model);
  if (!price) return null;
  const input = Math.max(0, Number(tokens?.input || tokens?.input_tokens || 0));
  const output = Math.max(0, Number(tokens?.output || tokens?.output_tokens || 0));
  const reasoning = Math.max(0, Number(tokens?.reasoning || tokens?.reasoning_tokens || 0));
  const cached = Math.max(0, Number(tokens?.cached || tokens?.cached_tokens || 0));
  const cacheWrite = Math.max(0, Number(tokens?.cacheWrite || tokens?.cache_write_tokens || 0));
  const inputCost = input * (price.inputCostPerToken || 0);
  const outputCost = (output + reasoning) * (price.outputCostPerToken || 0);
  const cacheReadCost = cached * (price.cacheReadCostPerToken ?? price.inputCostPerToken ?? 0);
  const cacheWriteCost = cacheWrite * (price.cacheWriteCostPerToken ?? price.inputCostPerToken ?? 0);
  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  return {
    usd: Number(total.toFixed(12)),
    model: price.model,
    provider: price.provider,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    price,
  };
}

export function getPricingSnapshot() {
  return {
    source: _state.source,
    sourceUrl: _state.sourceUrl,
    fetchedAt: _state.fetchedAt,
    modelCount: _state.modelCount,
    lastError: _state.lastError,
    prices: _state.prices,
  };
}
