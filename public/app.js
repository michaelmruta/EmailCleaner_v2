'use strict';

function app() {
  return {
    connected: false,
    userEmail: '',
    connecting: false,
    restoringSession: false,
    authError: '',

    form: { email: '', password: '' },

    SESSION_KEY:   'ec_session',
    RUN_START_KEY: 'ec_run_started_at',
    LOGS_KEY:      'ec_logs',

    process: {
      status: 'idle', total: 0, done: 0, moved: 0, deleted: 0, saved: 0, currentAction: '',
      perSec: 0, etaSeconds: null, grandTotal: null, grandRemaining: null, grandEtaSeconds: null,
    },
    stats:   { folders: {} },

    pipeline: {
      poolSize: 0, poolCapacity: 0, fetchChunk: 0, fetchTotalChunks: 0,
      llmState: 'idle', llmStartedAt: null,
    },

    feed: [],
    logs: [],
    rules: null,
    tab: 'dashboard',

    _es: null,
    runStartedAt: null, // wall-clock ms when the current run started (persists through pause/resume)
    now: Date.now(), // ticks every 250ms — reactive clock source for live elapsed timers

    // ── AI settings modal ───────────────────────────────────
    showSettings:  false,
    aiConfig:      { provider: 'ollama', model: '' },
    aiSavedModels: {},
    aiProviders:   [],
    aiModels:      [],
    loadingModels: false,
    aiModelsError: '',

    // ── Init ──────────────────────────────────────────────
    async init() {
      // Restore across page refreshes — the actual run start time (so elapsed
      // time keeps counting from when the run really began) and the console log.
      this.runStartedAt = this.loadRunStartedAt();
      this.logs         = this.loadLogs();
      setInterval(() => { this.now = Date.now(); }, 250);

      try {
        const res  = await fetch('/api/status');
        const data = await res.json();
        this.applyState(data);
        if (data.connected) {
          this.startSSE();
          return;
        }
      } catch {}

      // Server has no active session — try replaying a saved one from this browser.
      const saved = this.loadSession();
      if (saved) {
        this.form.email    = saved.email;
        this.form.password = saved.password;
        this.restoringSession = true;
        await this.connect();
        this.restoringSession = false;
      }
    },

    // ── Local session persistence ──────────────────────────
    loadSession() {
      try { return JSON.parse(localStorage.getItem(this.SESSION_KEY)); }
      catch { return null; }
    },
    saveSession(email, password) {
      try { localStorage.setItem(this.SESSION_KEY, JSON.stringify({ email, password })); }
      catch {}
    },
    clearSession() {
      try { localStorage.removeItem(this.SESSION_KEY); }
      catch {}
    },

    // ── Run start time + logs persistence (survive page refresh) ───────────
    loadRunStartedAt() {
      try {
        const v = localStorage.getItem(this.RUN_START_KEY);
        return v ? Number(v) : null;
      } catch { return null; }
    },
    saveRunStartedAt(ts) {
      try { localStorage.setItem(this.RUN_START_KEY, String(ts)); }
      catch {}
    },
    clearRunStartedAt() {
      try { localStorage.removeItem(this.RUN_START_KEY); }
      catch {}
    },

    loadLogs() {
      try { return JSON.parse(localStorage.getItem(this.LOGS_KEY)) || []; }
      catch { return []; }
    },
    saveLogs() {
      try { localStorage.setItem(this.LOGS_KEY, JSON.stringify(this.logs)); }
      catch {}
    },

    // ── Connect ───────────────────────────────────────────
    async connect() {
      this.connecting = true;
      this.authError  = '';
      const email    = this.form.email;
      const password = this.form.password;
      try {
        const res  = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (data.success) {
          this.connected = true;
          this.userEmail = email;
          this.saveSession(email, password);
          this.form.password = '';
          this.startSSE();
        } else {
          this.authError = data.error || 'Connection failed. Check credentials.';
          this.clearSession();
        }
      } catch (e) {
        this.authError = 'Server error: ' + e.message;
      } finally {
        this.connecting = false;
      }
    },

    async disconnect() {
      await fetch('/api/disconnect', { method: 'POST' });
      this.connected = false;
      this.clearSession();
      if (this._es) { this._es.close(); this._es = null; }
    },

    // ── SSE ───────────────────────────────────────────────
    startSSE() {
      if (this._es) this._es.close();
      this._es = new EventSource('/api/events');
      this._es.onmessage = (e) => {
        try { this.handleEvent(JSON.parse(e.data)); } catch {}
      };
      this._es.onerror = () => {
        this.addLog('warn', 'SSE connection lost, reconnecting…');
      };
    },

    handleEvent(msg) {
      switch (msg.type) {
        case 'init':
        case 'status':
          this.applyState(msg.data);
          this.trackRunStart();
          break;
        case 'progress':
          Object.assign(this.process, msg.data);
          this.trackRunStart();
          break;
        case 'activity':
          this.feed.unshift(msg.data);
          if (this.feed.length > 150) this.feed.pop();
          this.$nextTick(() => {
            const el = document.getElementById('feed-list');
            if (el && el.scrollTop < 40) el.scrollTop = 0;
          });
          break;
        case 'stats':
          this.stats = msg.data;
          break;
        case 'pipeline':
          Object.assign(this.pipeline, msg.data);
          break;
        case 'log':
          this.addLog(msg.data.level, msg.data.msg);
          break;
      }
    },

    applyState(data) {
      if (!data) return;
      if (data.connected  !== undefined) this.connected  = data.connected;
      if (data.credentials?.email)       this.userEmail  = data.credentials.email;
      if (data.process)  Object.assign(this.process, data.process);
      if (data.stats)    this.stats = data.stats;
      if (data.pipeline) Object.assign(this.pipeline, data.pipeline);
      if (data.feed)     this.feed  = data.feed;
    },

    // ── Client-side rate/ETA (speed = done / elapsed, remaining = left / speed) ──
    trackRunStart() {
      if (this.process.status === 'running' && !this.runStartedAt) {
        this.runStartedAt = Date.now();
        this.saveRunStartedAt(this.runStartedAt);
      } else if (['idle', 'stopped'].includes(this.process.status)) {
        this.runStartedAt = null;
        this.clearRunStartedAt();
      }
    },

    clientStats() {
      if (!this.runStartedAt) return { elapsedSeconds: null, perSec: 0, etaSeconds: null };
      const elapsedSeconds = (Date.now() - this.runStartedAt) / 1000;
      const haveGrand = this.process.grandTotal !== null && this.process.grandRemaining !== null;
      const done      = haveGrand ? this.process.grandTotal - this.process.grandRemaining : this.process.done;
      const remaining = haveGrand ? this.process.grandRemaining : Math.max(0, this.process.total - this.process.done);
      const perSec    = elapsedSeconds > 0 && done > 0 ? done / elapsedSeconds : 0;
      const etaSeconds = perSec > 0 ? Math.round(remaining / perSec) : null;
      return { elapsedSeconds, perSec, etaSeconds };
    },

    // ── API ───────────────────────────────────────────────
    async apiPost(url) {
      try {
        await fetch(url, { method: 'POST' });
      } catch (e) {
        this.addLog('error', 'API error: ' + e.message);
      }
    },

    async confirmReset() {
      if (!confirm('Reset progress counters? This does NOT undo emails already moved/deleted.')) return;
      await this.apiPost('/api/process/reset');
    },

    // ── Rules ─────────────────────────────────────────────
    async loadRules() {
      if (this.rules) return;
      try {
        const res = await fetch('/api/rules');
        this.rules = await res.json();
      } catch (e) {
        this.addLog('error', 'Failed to load rules: ' + e.message);
      }
    },

    // ── AI settings ─────────────────────────────────────────
    async openSettings() {
      this.showSettings = true;
      try {
        const res  = await fetch('/api/ai/config');
        const data = await res.json();
        this.aiConfig      = { provider: data.provider, model: data.model };
        this.aiSavedModels = data.models || {};
        this.aiProviders   = data.providers || [];
      } catch (e) {
        this.addLog('error', 'Failed to load AI config: ' + e.message);
      }
      await this.loadAiModels();
    },

    async onProviderChange() {
      this.aiConfig.model = this.aiSavedModels[this.aiConfig.provider] || '';
      await this.loadAiModels();
    },

    async loadAiModels() {
      this.loadingModels = true;
      this.aiModelsError = '';
      this.aiModels = [];
      try {
        const res  = await fetch('/api/ai/models?provider=' + encodeURIComponent(this.aiConfig.provider));
        const data = await res.json();
        if (data.error) {
          this.aiModelsError = data.error;
        } else {
          this.aiModels = data.models || [];
          if (this.aiModels.length && !this.aiModels.includes(this.aiConfig.model)) {
            this.aiConfig.model = this.aiModels[0];
          }
        }
      } catch (e) {
        this.aiModelsError = 'Failed to load models: ' + e.message;
      } finally {
        this.loadingModels = false;
      }
    },

    async saveAiConfig() {
      try {
        const res  = await fetch('/api/ai/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.aiConfig),
        });
        const data = await res.json();
        this.aiConfig = { provider: data.provider, model: data.model };
        this.showSettings = false;
      } catch (e) {
        this.addLog('error', 'Failed to save AI config: ' + e.message);
      }
    },

    // ── Helpers ───────────────────────────────────────────
    addLog(level, msg) {
      const time = new Date().toTimeString().slice(0, 8);
      this.logs.unshift({ level, msg, time });
      if (this.logs.length > 300) this.logs.pop();
      this.saveLogs();
      this.$nextTick(() => {
        const el = document.getElementById('log-list');
        if (el && el.scrollTop < 40) el.scrollTop = 0;
      });
    },

    pct(done, total) {
      if (!total) return 0;
      return Math.min(100, Math.floor((done / total) * 100));
    },

    // ── Pipeline visualizer (fetch / LLM pool / LLM call, live) ────────────
    poolBar() {
      const cap  = this.pipeline.poolCapacity || 0;
      const size = Math.min(this.pipeline.poolSize, cap);
      return 'X'.repeat(size) + '-'.repeat(Math.max(0, cap - size));
    },

    poolStatusText() {
      const { poolSize, poolCapacity } = this.pipeline;
      if (!poolCapacity || poolSize === 0) return 'pool not yet ready';
      if (poolSize >= poolCapacity) return 'pool full — dispatching…';
      return `collecting… (${poolSize}/${poolCapacity})`;
    },

    fetchTicker(n = 30) {
      const letter = action => action === 'move' ? 'M' : action === 'delete' ? 'D' : action === 'save' ? 'S' : '?';
      return this.feed.slice(0, n).map(item => ({ action: item.action, letter: letter(item.action) })).reverse();
    },

    llmElapsedSeconds() {
      if (this.pipeline.llmState !== 'thinking' || !this.pipeline.llmStartedAt) return null;
      return Math.max(0, (this.now - this.pipeline.llmStartedAt) / 1000);
    },

    llmCallText() {
      const elapsed = this.llmElapsedSeconds();
      return elapsed !== null ? `thinking… ${elapsed.toFixed(1)}s` : 'waiting…';
    },

    fmt(n) {
      if (n === undefined || n === null) return '0';
      return Number(n).toLocaleString();
    },

    fmtRate(perSec) {
      if (!perSec) return '—';
      return perSec >= 10 ? Math.round(perSec) + '/s' : perSec.toFixed(1) + '/s';
    },

    fmtEta(seconds) {
      if (seconds === null || seconds === undefined) return '—';
      if (seconds < 1) return 'almost done';
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    },

    etaParts(seconds) {
      if (seconds === null || seconds === undefined) return { d: 0, h: 0, m: 0 };
      return {
        d: Math.floor(seconds / 86400),
        h: Math.floor((seconds % 86400) / 3600),
        m: Math.floor((seconds % 3600) / 60),
      };
    },

    truncate(str, len) {
      if (!str) return '';
      return str.length > len ? str.slice(0, len) + '…' : str;
    },

    feedClass(action) {
      if (action === 'move')   return 'feed-item feed-move';
      if (action === 'delete') return 'feed-item feed-delete';
      if (action === 'save')   return 'feed-item feed-save';
      return 'feed-item';
    },

    sortedFolders() {
      return Object.entries(this.stats.folders || {}).sort((a, b) => b[1] - a[1]);
    },

    barPct(count) {
      const max = Math.max(
        this.process.deleted || 0,
        this.process.saved   || 0,
        ...Object.values(this.stats.folders || {})
      );
      if (!max) return 0;
      return Math.max(2, Math.floor((count / max) * 100));
    },
  };
}
