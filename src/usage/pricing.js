'use strict';
// USD per million tokens, from Anthropic's pricing page
// (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-24).
// Every value can be overridden in settings (claudeStudio.usage.pricing).
// Order matters: more specific ids first.

const PRICES = [
  ['fable-5-1',  { input: 10,   output: 50,  cacheWrite5m: 12.5,  cacheWrite1h: 20,  cacheRead: 0.25 }],
  ['mythos-5-1', { input: 10,   output: 50,  cacheWrite5m: 12.5,  cacheWrite1h: 20,  cacheRead: 0.25 }],
  ['opus-5-5',   { input: 4,    output: 20,  cacheWrite5m: 5,     cacheWrite1h: 8,   cacheRead: 0.2 }],
  ['sonnet-5-5', { input: 2,    output: 10,  cacheWrite5m: 2.5,   cacheWrite1h: 4,   cacheRead: 0.1 }],
  ['haiku-5-5',  { input: 0.1,  output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01,
                   long: { threshold: 100000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } }],
  ['fable-5',    { input: 10,   output: 50,  cacheWrite5m: 12.5,  cacheWrite1h: 20,  cacheRead: 1 }],
  ['mythos-5',   { input: 10,   output: 50,  cacheWrite5m: 12.5,  cacheWrite1h: 20,  cacheRead: 1 }],
  ['opus-5',     { input: 5,    output: 25,  cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 }],
  ['opus-4-8',   { input: 5,    output: 25,  cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 }],
  ['opus-4-7',   { input: 5,    output: 25,  cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 }],
  ['opus-4-6',   { input: 5,    output: 25,  cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 }],
  ['opus-4-5',   { input: 5,    output: 25,  cacheWrite5m: 6.25,  cacheWrite1h: 10,  cacheRead: 0.5 }],
  ['opus-4-1',   { input: 15,   output: 75,  cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 }],
  ['opus-4',     { input: 15,   output: 75,  cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 }],
  ['sonnet-5',   { input: 2,    output: 10,  cacheWrite5m: 2.5,   cacheWrite1h: 4,   cacheRead: 0.2 }],
  ['sonnet-4',   { input: 3,    output: 15,  cacheWrite5m: 3.75,  cacheWrite1h: 6,   cacheRead: 0.3 }],
  ['haiku-4-5',  { input: 1,    output: 5,   cacheWrite5m: 1.25,  cacheWrite1h: 2,   cacheRead: 0.1 }],
  ['3-5-haiku',  { input: 0.8,  output: 4,   cacheWrite5m: 1,     cacheWrite1h: 1.6, cacheRead: 0.08 }],
  ['haiku-3-5',  { input: 0.8,  output: 4,   cacheWrite5m: 1,     cacheWrite1h: 1.6, cacheRead: 0.08 }],
];
const FALLBACK = 'sonnet-5-5';

/** "claude-opus-5-5-20261001" -> "opus-5-5" price key */
function priceKey(model, overrides = {}) {
  const m = String(model || '').toLowerCase().replace(/\./g, '-');
  for (const k of Object.keys(overrides)) if (m.includes(k.toLowerCase())) return k;
  for (const [k] of PRICES) if (m.includes(k)) return k;
  return null;
}

function priceFor(model, overrides = {}) {
  const key = priceKey(model, overrides);
  if (key && overrides[key]) return { key, known: true, price: { ...(PRICES.find(p => p[0] === key) || [, {}])[1], ...overrides[key] } };
  if (key) return { key, known: true, price: PRICES.find(p => p[0] === key)[1] };
  return { key: FALLBACK, known: false, price: PRICES.find(p => p[0] === FALLBACK)[1] };
}

/**
 * Cost in USD of one API response's usage object.
 * @param {object} usage  { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} }
 */
function costOf(usage, model, overrides) {
  const { price } = priceFor(model, overrides);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const created = usage.cache_creation_input_tokens || 0;
  const cc = usage.cache_creation || {};
  const w1h = Math.min(created, cc.ephemeral_1h_input_tokens || 0);
  const w5m = Math.max(0, created - w1h);

  let p = price;
  if (price.long && input + read + created > price.long.threshold) p = { ...price, ...price.long };

  return (input * p.input + output * p.output + read * p.cacheRead + w5m * p.cacheWrite5m + w1h * p.cacheWrite1h) / 1e6;
}

module.exports = { PRICES, priceKey, priceFor, costOf, FALLBACK };
