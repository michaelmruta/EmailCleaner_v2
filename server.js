'use strict';
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3333;
try { execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: 'ignore' }); } catch {}

const { state, emitter, broadcast } = require('./src/state');
const processor = require('./src/processor');
const llm = require('./src/llm');

const DATA_DIR   = path.join(__dirname, 'data');
const PROG_FILE  = path.join(DATA_DIR, 'progress.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'init', data: safeState() })}\n\n`);

  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

emitter.on('sse', event => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) c.write(data);
});

function safeState() {
  return {
    ...state,
    credentials: state.credentials ? { email: state.credentials.email } : null,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

  broadcast('log', { level: 'info', msg: 'Testing connection to Yahoo IMAP…' });
  const result = await processor.testConnection(email, password);

  if (result.success) {
    state.credentials = { email, password };
    state.connected   = true;
    broadcast('status', { connected: true });
    res.json({ success: true });
  } else {
    res.json({ success: false, error: result.error });
  }
});

app.post('/api/disconnect', (req, res) => {
  state.credentials = null;
  state.connected   = false;
  broadcast('status', { connected: false });
  res.json({ ok: true });
});

// ── Process controls ──────────────────────────────────────────────────────────
app.post('/api/process/start', (req, res) => {
  if (!state.credentials) return res.status(401).json({ error: 'Not connected' });
  if (state.process.status === 'running') return res.json({ ok: true, msg: 'Already running' });
  state.process.runStartedAt = Date.now();
  res.json({ ok: true });
  processor.start(state.credentials);
});

app.post('/api/process/pause', (req, res) => {
  processor.pause();
  res.json({ ok: true });
});

app.post('/api/process/resume', (req, res) => {
  if (!state.credentials) return res.status(401).json({ error: 'Not connected' });
  res.json({ ok: true });
  if (processor.isRunning()) {
    processor.resume();
  } else {
    // No live connection survived (e.g. a server restart) — this is really a fresh
    // start() under the hood, so it needs its own runStartedAt just like Start does.
    state.process.runStartedAt = Date.now();
    processor.start(state.credentials);
  }
});

app.post('/api/process/stop', (req, res) => {
  processor.stop();
  res.json({ ok: true });
});

// ── Progress reset ────────────────────────────────────────────────────────────
app.post('/api/process/reset', (req, res) => {
  if (state.process.status === 'running') return res.status(400).json({ error: 'Cannot reset while running' });
  try { fs.unlinkSync(PROG_FILE); } catch {}
  state.process  = { status: 'idle', total: 0, done: 0, moved: 0, deleted: 0, saved: 0, llmProcessed: 0, runStartedAt: null };
  state.stats    = { folders: {} };
  state.pipeline = { poolSize: 0, poolCapacity: 0, fetchChunk: 0, fetchTotalChunks: 0, llmActive: 0, llmCapacity: 0, llmCallStartedAts: [] };
  broadcast('status', { process: state.process, stats: state.stats });
  broadcast('pipeline', state.pipeline);
  res.json({ ok: true });
});

// ── Rules ─────────────────────────────────────────────────────────────────────
app.get('/api/rules', (req, res) => {
  const { DOMAIN_RULES, KEYWORD_RULES, SUBJECT_RULES, MARKETING_MAILERS } = require('./config/folders');
  res.json({
    domains:         Object.entries(DOMAIN_RULES).map(([domain, folder]) => ({ domain, folder })),
    keywords:        KEYWORD_RULES.map(r => ({ match: r.match, folder: r.folder })),
    subjects:        SUBJECT_RULES.map(r => ({ pattern: r.re.source, action: r.action, folder: r.folder || null, reason: r.reason || null })),
    marketingMailers: MARKETING_MAILERS,
  });
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json(safeState()));

// ── AI classifier config ────────────────────────────────────────────────────
app.get('/api/ai/config', (req, res) => res.json(llm.getConfig()));

app.post('/api/ai/config', (req, res) => {
  const cfg = llm.setConfig(req.body || {});
  broadcast('aiConfig', cfg);
  broadcast('log', { level: 'info', msg: `AI classifier set to ${cfg.provider} (${cfg.model})` });
  res.json(cfg);
});

app.get('/api/ai/models', async (req, res) => {
  const provider = String(req.query.provider || '');
  try {
    const models = await llm.listModels(provider);
    res.json({ models });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n  ${signal} — shutting down…`);
  await processor.shutdown();
  for (const c of sseClients) c.end();
  sseClients.clear();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  const aiCfg = llm.getConfig();
  console.log(`\n  EmailCleaner v2 → http://localhost:${PORT}`);
  console.log(`  AI classifier: ${aiCfg.provider} (${aiCfg.model})\n`);

  // Restore progress from disk — status too, so a finished/interrupted run reads
  // back as 'done'/'paused' instead of showing a stale total/done next to 'idle'.
  try {
    const p = JSON.parse(fs.readFileSync(PROG_FILE, 'utf8'));
    state.process.total = p.total || 0;
    state.process.done  = p.done  || 0;
    if (p.status === 'running' || p.status === 'paused') {
      state.process.status = 'paused'; // no live IMAP connection survives a restart, but it's resumable
    } else if (p.status === 'done' || p.status === 'stopped') {
      state.process.status = p.status;
    }
  } catch {}

  // Auto-connect from .env
  const envEmail = process.env.YAHOO_EMAIL;
  const envPass  = process.env.YAHOO_APP_PASSWORD;
  if (envEmail && envPass) {
    console.log(`  Auto-connecting as ${envEmail}…`);
    const result = await processor.testConnection(envEmail, envPass);
    if (result.success) {
      state.credentials = { email: envEmail, password: envPass };
      state.connected   = true;
      console.log('  Connected to Yahoo IMAP ✓\n');
    } else {
      console.error(`  IMAP connection failed: ${result.error}\n`);
    }
  }
});
