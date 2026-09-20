'use strict';

function app() {
  // Non-reactive cache for chartRender() — keyed on history length + newest
  // sample timestamp, so it recomputes only when a new point lands, never on
  // hover. Kept off the reactive object to avoid self-triggering effects.
  let chartKey = null;
  let chartCache = null;

  return {
    connected: false,
    userEmail: '',
    connecting: false,
    restoringSession: false,
    authError: '',

    form: { email: '', password: '' },

    SESSION_KEY: 'ec_session',
    LOGS_KEY:    'ec_logs',

    process: {
      status: 'idle', total: 0, done: 0, moved: 0, deleted: 0, saved: 0, llmProcessed: 0, currentAction: '',
      perSec: 0, etaSeconds: null, grandTotal: null, grandRemaining: null, grandEtaSeconds: null,
      runStartedAt: null,
    },
    stats:   { folders: {} },

    // ── Activity-over-time chart (client-sampled from progress events) ────
    CHART_SERIES: [
      { key: 'llmProcessed', label: 'LLM processed', color: 'var(--orange)' },
      { key: 'moved',        label: 'Moved',         color: 'var(--green)' },
      { key: 'deleted',      label: 'Deleted',       color: 'var(--red)' },
      { key: 'saved',        label: 'mbox',          color: 'var(--teal)' },
    ],
    HISTORY_MAX: 600,       // ~20 min of history at the 2s sampling interval below
    history: [],
    _lastHistoryAt: 0,
    hoverIdx: null,

    pipeline: {
      poolSize: 0, poolCapacity: 0, fetchChunk: 0, fetchTotalChunks: 0,
      llmActive: 0, llmCapacity: 0, llmCallStartedAts: [],
    },

    feed: [],
    logs: [],
    rules: null,
    tab: 'dashboard',

    _es: null,
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
      // Restore the console log across page refreshes. Elapsed time doesn't need
      // its own persistence — it's derived from process.runStartedAt, which the
      // server owns and sends on every status/init event.
      this.logs = this.loadLogs();
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

    // ── Log persistence (survive page refresh) ─────────────────────────────
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
          break;
        case 'progress':
          Object.assign(this.process, msg.data);
          this.recordHistorySample();
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
    // runStartedAt is server-owned (set only when the Start endpoint fires) and
    // arrives via process.runStartedAt on every status/progress event — no local
    // tracking needed, which also means it can't drift out of sync after a
    // server restart the way a client-invented timestamp could.
    clientStats() {
      if (!this.process.runStartedAt) return { elapsedSeconds: null, perSec: 0, etaSeconds: null };
      const elapsedSeconds = (this.now - this.process.runStartedAt) / 1000;
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
      this.history = [];
    },

    // Wraps the Start button's API call so a fresh run also clears the
    // previous run's chart history instead of appending onto it.
    async startProcess() {
      this.history = [];
      await this.apiPost('/api/process/start');
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

    // ── Activity-over-time chart ────────────────────────────────────────
    // Throttled to one sample per 2s (not one per progress event, which fires
    // per rule/LLM batch and would flood the buffer) and capped at HISTORY_MAX
    // so a long-running session ages out its oldest points instead of growing forever.
    recordHistorySample() {
      const now = Date.now();
      if (this.history.length && now - this._lastHistoryAt < 2000) return;
      this._lastHistoryAt = now;
      this.history.push({
        t:            now,
        llmProcessed: this.process.llmProcessed || 0,
        moved:        this.process.moved        || 0,
        deleted:      this.process.deleted      || 0,
        saved:        this.process.saved        || 0,
      });
      if (this.history.length > this.HISTORY_MAX) this.history.shift();
    },

    // Computed once per render and reused across the template via `x-for="chart in [chartRender()]"`
    // — avoids recomputing scales/paths separately for every bound expression.
    chartRender() {
      const W = 360, H = 110, padL = 36, padR = 6, padT = 8, padB = 8;
      const innerW = W - padL - padR, innerH = H - padT - padB;
      const pts = this.history;
      const n   = pts.length;
      const maxY = Math.max(1, ...pts.flatMap(p => this.CHART_SERIES.map(s => p[s.key])));
      const x = i => padL + (n <= 1 ? innerW : (i / (n - 1)) * innerW);
      const y = v => padT + innerH - (v / maxY) * innerH;

      const series = this.CHART_SERIES.map(s => ({
        ...s,
        path: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' '),
        lastX: n ? x(n - 1) : padL,
        lastY: n ? y(pts[n - 1][s.key]) : padT + innerH,
      }));

      const yTicks = [0, 0.5, 1].map(f => ({
        y:     padT + innerH - f * innerH,
        label: this.fmtShort(Math.round(maxY * f)),
      }));

      return { W, H, padL, padT, innerW, n, x, series, yTicks, pts };
    },

    chartSpanLabel() {
      const chart = this.chartData();
      if (chart.n < 2) return '';
      const seconds = (chart.pts[chart.n - 1].t - chart.pts[0].t) / 1000;
      return 'last ' + this.fmtEta(seconds);
    },

    chartViewBox() {
      const chart = this.chartData();
      return '0 0 ' + chart.W + ' ' + chart.H;
    },

    // Everything inside the <svg> is built as a string here and injected via
    // x-html — Alpine template x-for can't resolve loop vars inside an SVG
    // element, so we generate the markup directly (grid, ticks, series lines,
    // end markers, and the hover crosshair) instead of using <template x-for>.
    chartMarkup() {
      const c = this.chartData();
      const { padL, padT, W, H, n, series, yTicks, x } = c;
      let m = '';
      for (const t of yTicks) {
        m += `<line class="chart-grid" x1="${padL}" x2="${W - 12}" y1="${t.y}" y2="${t.y}"/>`;
      }
      for (const t of yTicks) {
        m += `<text class="chart-ytick" x="${padL - 6}" y="${t.y + 3}">${t.label}</text>`;
      }
      for (const s of series) {
        m += `<path class="chart-line" d="${s.path}" fill="none" stroke="${s.color}" stroke-width="1.5"/>`;
      }
      for (const s of series) {
        m += `<g><circle class="chart-end-ring" cx="${s.lastX}" cy="${s.lastY}" r="6"/><circle cx="${s.lastX}" cy="${s.lastY}" r="4" fill="${s.color}"/></g>`;
      }
      if (this.hoverIdx !== null && n) {
        const hx = x(this.hoverIdx);
        m += `<line class="chart-crosshair" x1="${hx.toFixed(1)}" x2="${hx.toFixed(1)}" y1="${padT}" y2="${H - 10}"/>`;
      }
      return m;
    },

    // Flat cached accessor for the chart — every template binding calls this
    // instead of a nested x-for loop variable, because Alpine drops the outer
    // loop scope inside a nested <template x-for> (only the first item renders).
    chartData() {
      const pts   = this.history;
      const last  = pts.length ? pts[pts.length - 1] : null;
      const key   = pts.length + ':' + (last ? last.t : 0);
      if (chartKey !== key || !chartCache) {
        chartKey  = key;
        chartCache = this.chartRender();
      }
      return chartCache;
    },

    onChartMove(e) {
      const chart = this.chartData();
      if (!chart.n) return;
      const rect  = e.currentTarget.getBoundingClientRect();
      const relX  = ((e.clientX - rect.left) / rect.width) * chart.W;
      const frac  = chart.n <= 1 ? 0 : (relX - chart.padL) / chart.innerW;
      this.hoverIdx = Math.min(chart.n - 1, Math.max(0, Math.round(frac * (chart.n - 1))));
    },

    onChartLeave() {
      this.hoverIdx = null;
    },

    hoverTime() {
      const chart = this.chartData();
      if (this.hoverIdx === null || !chart.pts[this.hoverIdx]) return '';
      return new Date(chart.pts[this.hoverIdx].t).toTimeString().slice(0, 8);
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
      return this.feed.slice(0, n).map(item => ({
        action: item.action,
        letter: letter(item.action),
        isLLM: !!(item.source && item.source.startsWith('llm')),
      })).reverse();
    },

    // One entry per concurrency slot (llmCapacity total) — active slots show
    // elapsed time for that call, idle slots show a dash.
    llmSlots() {
      const cap    = this.pipeline.llmCapacity || 0;
      const starts = this.pipeline.llmCallStartedAts || [];
      return Array.from({ length: cap }, (_, i) => {
        const startedAt = starts[i];
        return startedAt
          ? { active: true, elapsed: Math.max(0, (this.now - startedAt) / 1000) }
          : { active: false, elapsed: null };
      });
    },

    fmt(n) {
      if (n === undefined || n === null) return '0';
      return Number(n).toLocaleString();
    },

    // Compact tick labels — "1.2k", "3.4M" — so the chart stays legible in a
    // slim middle column even when a series climbs into the tens of thousands.
    fmtShort(n) {
      if (n === undefined || n === null) return '0';
      if (n < 1000) return String(n);
      if (n < 100000) {
        const k = n / 1000;
        return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + 'k';
      }
      const m = n / 1000000;
      return (Number.isInteger(m) ? String(m) : m.toFixed(1)) + 'M';
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
