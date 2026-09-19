'use strict';
const fs = require('fs');
const path = require('path');
const { YAHOO_FOLDERS } = require('../config/folders');

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const PROVIDERS  = ['ollama', 'openai', 'anthropic', 'openrouter'];

const DEFAULT_MODELS = {
  ollama:     process.env.OLLAMA_MODEL     || 'qwen3:1.7b',
  openai:     process.env.OPENAI_MODEL     || 'gpt-4o-mini',
  anthropic:  process.env.ANTHROPIC_MODEL  || 'claude-haiku-4-5-20251001',
  openrouter: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
};

// ── Runtime config (switchable live via the settings modal, persisted to disk) ──
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'ai-config.json');

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      provider: PROVIDERS.includes(saved.provider) ? saved.provider : (process.env.AI_PROVIDER || 'ollama').toLowerCase(),
      models: { ...DEFAULT_MODELS, ...(saved.models || {}) },
    };
  } catch {
    return { provider: (process.env.AI_PROVIDER || 'ollama').toLowerCase(), models: { ...DEFAULT_MODELS } };
  }
}

let _config = loadConfig();

function persistConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2));
  } catch { /* non-fatal */ }
}

function isConfigured(provider) {
  if (provider === 'ollama') return true;
  const envKey = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' }[provider];
  return !!process.env[envKey];
}

function getConfig() {
  return {
    provider:  _config.provider,
    model:     _config.models[_config.provider],
    models:    { ..._config.models },
    providers: PROVIDERS.map(id => ({ id, configured: isConfigured(id) })),
  };
}

function setConfig({ provider, model } = {}) {
  if (provider && PROVIDERS.includes(provider)) _config.provider = provider;
  if (model) _config.models[_config.provider] = model;
  persistConfig();
  return getConfig();
}

// ── Prompts ────────────────────────────────────────────────────────────────
const RULES_TEXT = [
  'Rules:',
  '- Only use "move" if the sender IS that specific company/service (e.g. only use folder "Netflix" for actual Netflix emails, never for other streaming or unrelated senders). Do not guess a similarly-themed folder — an invoice from an unrelated vendor is NOT a match just because some folder relates to billing.',
  '- Use "delete" for spam, marketing/promo blasts, notifications, OTPs/verification codes, social media noise, newsletters/digests.',
  '- Use "keep" whenever the sender does not clearly match one of the named folders — including unrecognized but plausibly important senders (invoices, personal correspondence, confirmations from vendors not in the list). When unsure between "keep" and "delete", prefer "keep".',
].join('\n');

const SYSTEM_PROMPT = [
  'You are an email triage assistant for a personal Yahoo inbox cleanup tool.',
  `Available folders (each is a SPECIFIC named company/service, not a category): ${YAHOO_FOLDERS.join(', ')}`,
  'Decide exactly one action for the email described by the user and respond with ONLY strict JSON — no prose, no markdown fences:',
  '{"action":"move","folder":"<exact folder name from the list>"}',
  '{"action":"delete","reason":"<short reason>"}',
  '{"action":"keep"}',
  RULES_TEXT,
].join('\n');

const BATCH_SYSTEM_PROMPT = [
  'You are an email triage assistant for a personal Yahoo inbox cleanup tool.',
  `Available folders (each is a SPECIFIC named company/service, not a category): ${YAHOO_FOLDERS.join(', ')}`,
  'You will be given a numbered list of emails. Decide exactly one action per email, in order, and respond with ONLY strict JSON — no prose, no markdown fences:',
  '{"results":[{"action":"move","folder":"<exact folder name from the list>"}, {"action":"delete","reason":"<short reason>"}, {"action":"keep"}, ...]}',
  '"results" must have exactly one entry per email, in the same order as the numbered list.',
  RULES_TEXT,
].join('\n');

function buildUserPrompt(email) {
  const h = email.headers || {};
  return [
    `From: ${email.from}${email.fromName ? ` (${email.fromName})` : ''}`,
    `Subject: ${email.subject}`,
    `Has-Unsubscribe: ${!!h.listUnsubscribe}`,
    `Precedence: ${h.precedence || '-'}`,
    `X-Mailer: ${h.xMailer || '-'}`,
    `Has-Campaign-Id: ${!!h.hasCampaignId}`,
  ].join('\n');
}

function buildBatchUserPrompt(emails) {
  const lines = emails.map((email, i) => `${i + 1}. ${buildUserPrompt(email).replace(/\n/g, ' | ')}`);
  return `Classify these ${emails.length} emails. "results" must contain exactly ${emails.length} entries, in this order:\n\n${lines.join('\n')}`;
}

function extractJsonValue(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function normalize(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.action === 'move' && YAHOO_FOLDERS.includes(parsed.folder)) {
    return { action: 'move', folder: parsed.folder };
  }
  if (parsed.action === 'delete') {
    return { action: 'delete', reason: parsed.reason || 'llm classified as noise' };
  }
  if (parsed.action === 'keep') {
    return { action: 'keep' };
  }
  return null;
}

// ── Providers (systemPrompt/userPrompt/opts in, raw parsed JSON out) ─────────
async function callOllama(systemPrompt, userPrompt, { model }) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      format: 'json',
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return extractJsonValue(data.message?.content);
}

async function callOpenAI(systemPrompt, userPrompt, { model }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return extractJsonValue(data.choices?.[0]?.message?.content);
}

async function callAnthropic(systemPrompt, userPrompt, { model, maxTokens = 200 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return extractJsonValue(data.content?.[0]?.text);
}

async function callOpenRouter(systemPrompt, userPrompt, { model }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://localhost',
      'X-Title': 'EmailCleaner',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return extractJsonValue(data.choices?.[0]?.message?.content);
}

const CALLERS = { ollama: callOllama, openai: callOpenAI, anthropic: callAnthropic, openrouter: callOpenRouter };

// ── Model discovery ────────────────────────────────────────────────────────
async function listModels(provider) {
  if (provider === 'ollama') {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.models || []).map(m => m.name).sort();
  }

  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).filter(id => /^(gpt-|o[1-9])/.test(id)).sort();
  }

  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }

  if (provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }

  throw new Error(`Unknown provider "${provider}"`);
}

// ── Public API ───────────────────────────────────────────────────────────────
async function classifyWithLLM(email, log = () => {}) {
  const provider = _config.provider;
  const caller = CALLERS[provider];
  if (!caller) {
    log('warn', `Unknown AI_PROVIDER "${provider}" — skipping LLM classification.`);
    return null;
  }
  try {
    const parsed = await caller(SYSTEM_PROMPT, buildUserPrompt(email), { model: _config.models[provider] });
    const result = normalize(parsed);
    if (!result) {
      log('warn', `LLM (${provider}) returned an unparseable/invalid response — keeping unclassified.`);
      return null;
    }
    return { ...result, source: `llm:${provider}` };
  } catch (err) {
    log('warn', `LLM (${provider}) classification failed: ${err.message}`);
    return null;
  }
}

// Classifies a whole batch in one call. Returns an array (same length/order as
// `emails`, entries may be null if that particular item didn't normalize), or
// null if the batch as a whole failed/mismatched — caller should fall back to
// per-email classifyWithLLM in that case.
async function classifyBatchWithLLM(emails, log = () => {}) {
  if (emails.length === 0) return [];
  const provider = _config.provider;
  const caller = CALLERS[provider];
  if (!caller) {
    log('warn', `Unknown AI_PROVIDER "${provider}" — skipping LLM batch classification.`);
    return null;
  }
  try {
    const maxTokens = Math.min(6000, 100 + emails.length * 60);
    const parsed = await caller(BATCH_SYSTEM_PROMPT, buildBatchUserPrompt(emails), { model: _config.models[provider], maxTokens });
    const results = Array.isArray(parsed) ? parsed : parsed?.results;
    if (!Array.isArray(results) || results.length !== emails.length) {
      log('warn', `LLM (${provider}) batch response length mismatch (expected ${emails.length}, got ${Array.isArray(results) ? results.length : typeof results}) — falling back to per-email calls.`);
      return null;
    }
    return results.map(r => {
      const result = normalize(r);
      return result ? { ...result, source: `llm:${provider}:batch` } : null;
    });
  } catch (err) {
    log('warn', `LLM (${provider}) batch classification failed: ${err.message} — falling back to per-email calls.`);
    return null;
  }
}

module.exports = { classifyWithLLM, classifyBatchWithLLM, getConfig, setConfig, listModels };
