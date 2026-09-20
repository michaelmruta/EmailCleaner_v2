'use strict';
const EventEmitter = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const state = {
  connected: false,
  credentials: null,

  process: {
    status: 'idle',         // idle | running | paused | done | error
    total: 0,               // original INBOX total (set on first run, persists)
    done: 0,                // emails processed across all sessions
    moved: 0,               // moved to a folder (this session)
    deleted: 0,             // permanently deleted (this session)
    saved: 0,               // downloaded to mbox then deleted (this session)
    llmProcessed: 0,        // classified by the LLM rather than a rule (this session)
    currentAction: '',      // short description of current step (shown in UI)
    grandTotal: null,       // true INBOX size at session start (via IMAP STATUS, uncapped)
    grandRemaining: null,   // true emails remaining across the whole inbox
    runStartedAt: null,     // ms timestamp — set only when the Start button is pressed;
                             // persists through pause/resume/stop so elapsed time is
                             // server-authoritative (survives page refreshes for free)
  },

  stats: {
    folders: {},            // folder → count (this session)
  },

  // Live view into the fetch/rules/LLM pipeline — for the pipeline visualizer panel.
  pipeline: {
    poolSize:          0,      // ambiguous emails currently queued for the LLM (the filling pool)
    poolCapacity:      0,      // LLM_POOL_SIZE — pool hands off to a batch call once poolSize reaches this
    fetchChunk:        0,      // current IMAP fetch chunk number
    fetchTotalChunks:  0,      // total fetch chunks this pass
    llmActive:         0,      // number of LLM batch calls currently in flight (0..llmCapacity)
    llmCapacity:       0,      // MAX_CONCURRENT_LLM_CALLS — fetch pauses once this many are active
                                // AND the filling pool is also full
    llmCallStartedAts: [],     // ms timestamp per active call, oldest first — one slot per in-flight call
  },

  feed: [],                 // last 150 activity items
  error: null,
};

let _pauseResolve = null;
let _paused = false;

async function checkPaused() {
  if (_paused) {
    await new Promise(resolve => { _pauseResolve = resolve; });
  }
}

function setPaused(val) {
  _paused = val;
  if (!val && _pauseResolve) {
    _pauseResolve();
    _pauseResolve = null;
  }
}

function isPaused() { return _paused; }

function broadcast(type, data) {
  emitter.emit('sse', { type, data });
}

function addActivity(item) {
  state.feed.unshift(item);
  if (state.feed.length > 150) state.feed.pop();
  broadcast('activity', item);
}

module.exports = { state, emitter, broadcast, addActivity, checkPaused, setPaused, isPaused };
