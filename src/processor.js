'use strict';
const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');
const { classifyByRules, YAHOO_FOLDERS } = require('../config/folders');
const { state, broadcast, addActivity, checkPaused, setPaused } = require('./state');
const { classifyWithLLM, classifyBatchWithLLM } = require('./llm');
const { mapLimit } = require('./concurrency');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const PROG_FILE     = path.join(DATA_DIR, 'progress.json');
const MBOX_FILE     = path.join(DATA_DIR, 'unclassified.mbox');
const FOLDERS_FILE  = path.join(DATA_DIR, 'folders-ensured.json');
const BATCH_SIZE  = 40; // emails per IMAP fetch + per LLM batch call — tested up to 80 with 100% accuracy on gpt-oss:20b, 40 balances throughput vs blast radius
const BATCH_DELAY = 150; // ms between batches — avoids Yahoo IMAP rate limiting
const PARALLEL_WORKERS = Math.max(1, parseInt(process.env.PARALLEL_WORKERS, 10) || 5); // concurrent LLM calls / downloads per batch

let _aborted = false;
let _client  = null;

// ── Folder-check persistence (survives server restarts — only need this once per account) ──
function foldersAlreadyEnsuredFor(email) {
  try { return JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8')).email === email; }
  catch { return false; }
}
function markFoldersEnsured(email) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FOLDERS_FILE, JSON.stringify({ email, at: new Date().toISOString() }));
  } catch { /* non-fatal */ }
}

// ── Throughput tracking (emails/sec + ETA) ────────────────────────────────────
const RATE_WINDOW_MS = 30000;
let _rateSamples = []; // { t, done }

function resetRate() {
  _rateSamples = [];
}

function recordRateSample() {
  const now = Date.now();
  _rateSamples.push({ t: now, done: state.process.done });
  _rateSamples = _rateSamples.filter(s => now - s.t <= RATE_WINDOW_MS);
}

function computeRate() {
  if (_rateSamples.length < 2) return { perSec: 0, etaSeconds: null };
  const oldest = _rateSamples[0];
  const newest = _rateSamples[_rateSamples.length - 1];
  const dt    = (newest.t - oldest.t) / 1000;
  const dDone = newest.done - oldest.done;
  const perSec = dt > 0 && dDone > 0 ? dDone / dt : 0;
  const remaining   = Math.max(0, state.process.total - state.process.done);
  const etaSeconds  = perSec > 0 ? Math.round(remaining / perSec) : null;
  return { perSec, etaSeconds };
}

// ── IMAP client ──────────────────────────────────────────────────────────────
function getClient(credentials) {
  return new ImapFlow({
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    auth: { user: credentials.email, pass: credentials.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
}

// ── Progress persistence ─────────────────────────────────────────────────────
function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROG_FILE, 'utf8')); }
  catch { return { total: 0, done: 0 }; }
}

function saveProgress(p) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROG_FILE, JSON.stringify(p));
}

// ── Fetch a batch's headers/envelope (kicked off early, awaited later — lets it
// overlap with the previous batch's LLM call, which is on a separate connection) ──
function fetchBatchMsgs(client, batch) {
  return (async () => {
    const msgs = [];
    for await (const msg of client.fetch(batch.join(','), {
      uid: true,
      envelope: true,
      headers: true,
    }, { uid: true })) {
      msgs.push({ uid: msg.uid, envelope: msg.envelope, headers: msg.headers });
    }
    return { msgs };
  })().catch(err => ({ error: err }));
}

// ── Header parsing (msg.headers is a Buffer) ─────────────────────────────────
function parseHeaders(buf) {
  const result = {};
  if (!buf) return result;
  let current = null;
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  for (const line of text.split(/\r?\n/)) {
    if (/^\s+/.test(line) && current) {
      result[current] = (result[current] || '') + ' ' + line.trim();
    } else {
      const m = line.match(/^([^:]+):\s*(.*)/);
      if (m) { current = m[1].toLowerCase(); result[current] = m[2].trim(); }
    }
  }
  return result;
}

// ── Mbox append ──────────────────────────────────────────────────────────────
function mboxTimestamp() {
  const d = new Date();
  const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = n => String(n).padStart(2,'0');
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2,' ')} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`;
}

async function appendToMbox(rawBuf, envelope) {
  const from = envelope?.from?.[0]?.address || 'unknown@unknown';
  const fromLine = `From ${from} ${mboxTimestamp()}\n`;
  const body = rawBuf.toString('binary').replace(/^From /gm, '>From ');
  const entry = fromLine + body + (body.endsWith('\n') ? '\n' : '\n\n');
  fs.appendFileSync(MBOX_FILE, entry, 'binary');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function setAction(text) {
  state.process.currentAction = text;
  broadcast('status', { process: state.process });
}

function log(level, msg) {
  broadcast('log', { level, msg });
}

// ── Ensure target folders exist, one by one with status feedback ──────────────
async function ensureFolders(client) {
  let created = 0;
  let existed = 0;
  for (let i = 0; i < YAHOO_FOLDERS.length; i++) {
    const folder = YAHOO_FOLDERS[i];
    setAction(`Checking folder ${i + 1}/${YAHOO_FOLDERS.length}: ${folder}`);
    try {
      // ImapFlow resolves (not throws) on ALREADYEXISTS, with created:false — check that
      // flag rather than try/catch to tell an actual creation apart from a no-op.
      const result = await client.mailboxCreate(folder);
      if (result?.created) {
        created++;
        log('info', `  ✓ Created: ${folder}`);
      } else {
        existed++;
        log('info', `  · Exists:  ${folder}`);
      }
    } catch (err) {
      log('warn', `  ✗ Could not create/verify ${folder}: ${err.message}`);
    }
  }
  log('info', `Folders ready — ${created} created, ${existed} already existed.`);
}

// ── Main processor ───────────────────────────────────────────────────────────
async function start(credentials) {
  _aborted = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const progress = loadProgress();
  state.process.status        = 'running';
  state.process.done          = progress.done;
  state.process.total         = progress.total;
  state.process.moved         = 0;
  state.process.deleted       = 0;
  state.process.saved         = 0;
  state.process.currentAction = 'Connecting to Yahoo IMAP…';
  state.process.grandTotal     = null;
  state.process.grandRemaining = null;
  resetRate();
  broadcast('status', { process: state.process });

  const client = getClient(credentials);
  _client = client;

  try {
    await client.connect();
    log('info', 'Connected to Yahoo IMAP.');

    // True mailbox size — unlike search(), STATUS isn't capped at Yahoo's 10k limit,
    // so this lets us show one continuous ETA across the whole inbox, not just this pass.
    let grandTotal = null;
    try {
      const status = await client.status('INBOX', { messages: true });
      grandTotal = status.messages;
      state.process.grandTotal = grandTotal;
      log('info', `INBOX actual size: ${grandTotal.toLocaleString()} emails.`);
    } catch (err) {
      log('warn', `Could not read INBOX total size: ${err.message}`);
    }

    // ── 1. Ensure all target folders exist (only needs checking once per account, ever) ──
    if (!foldersAlreadyEnsuredFor(credentials.email)) {
      setAction('Ensuring Yahoo folders exist…');
      await ensureFolders(client);
      markFoldersEnsured(credentials.email);
    } else {
      log('info', 'Folders already verified previously — skipping check.');
    }

    let passCount        = 0;
    let totalSessionDone = 0;

    // ── 2. Loop until INBOX is empty or fewer than 10k remain ────────────
    while (!_aborted) {
      passCount++;

      setAction(passCount > 1
        ? `Pass ${passCount} — fetching INBOX list…`
        : 'Fetching INBOX email list…');
      log('info', passCount > 1
        ? `Pass ${passCount} — searching INBOX for remaining emails…`
        : 'Opening INBOX…');

      const lock = await client.getMailboxLock('INBOX');

      let allUids;
      try {
        allUids = await client.search({ all: true }, { uid: true });
      } catch (err) {
        lock.release();
        throw new Error(`INBOX search failed: ${err.message}`);
      }

      const remaining = allUids.length;
      log('info', `INBOX: ${remaining.toLocaleString()} emails found${remaining === 10000 ? ' (Yahoo max)' : ''}.`);

      if (remaining === 0) {
        lock.release();
        break;
      }

      // Reset per-pass progress (keep existing on first pass to support resume)
      if (passCount > 1) {
        progress.total      = remaining;
        progress.done       = 0;
        state.process.total = remaining;
        state.process.done  = 0;
        resetRate();
        saveProgress(progress);
      } else if (!progress.total) {
        progress.total      = remaining;
        state.process.total = remaining;
        saveProgress(progress);
      }

      broadcast('progress', { done: state.process.done, total: state.process.total });

      // ── 3. Process in batches (one batch's fetch pipelined against the previous
      //      batch's LLM call — separate connections, so they run concurrently) ──
      const batches = [];
      for (let i = 0; i < allUids.length; i += BATCH_SIZE) batches.push(allUids.slice(i, i + BATCH_SIZE));
      const totalBatches = batches.length;
      let sessionDone = 0;

      try {
        let fetchPromise = batches.length ? fetchBatchMsgs(client, batches[0]) : null;

        for (let b = 0; b < batches.length; b++) {
          if (_aborted) break;
          await checkPaused();

          const batchNum = b + 1;
          const batch    = batches[b];

          setAction(passCount > 1
            ? `Pass ${passCount} — ${batchNum}/${totalBatches} — ${state.process.done.toLocaleString()} done`
            : `Processing ${batchNum}/${totalBatches} — ${state.process.done.toLocaleString()} done`);

          // ── Fetch headers + envelope (already in flight from last iteration) ──
          const { msgs, error: fetchErr } = await fetchPromise;

          // Kick off the next batch's fetch now, before classifying this one —
          // it overlaps with the LLM call below instead of waiting behind it.
          fetchPromise = (b + 1 < batches.length) ? fetchBatchMsgs(client, batches[b + 1]) : null;

          if (fetchErr) {
            log('warn', `Batch ${batchNum} fetch error: ${fetchErr.message}`);
            sessionDone   += batch.length;
            progress.done += batch.length;
            state.process.done = Math.min(progress.total, progress.done);
            saveProgress(progress);
            broadcast('progress', { done: state.process.done, total: state.process.total });
            continue;
          }

          if (msgs.length === 0) {
            sessionDone   += batch.length;
            progress.done += batch.length;
            state.process.done = Math.min(progress.total, progress.done);
            saveProgress(progress);
            broadcast('progress', { done: state.process.done, total: state.process.total });
            continue;
          }

          // ── Classify ───────────────────────────────────────────────────
          const toMove   = new Map();   // folder → uid[]
          const toDelete = [];
          const toSave   = [];          // { uid, envelope }

          // Rule classification is synchronous — run it for the whole batch up front.
          const prepared = msgs.map(msg => {
            const h = parseHeaders(msg.headers);
            const emailData = {
              from:     msg.envelope?.from?.[0]?.address || '',
              fromName: msg.envelope?.from?.[0]?.name    || '',
              subject:  msg.envelope?.subject            || '',
              headers: {
                listUnsubscribe: !!h['list-unsubscribe'],
                precedence:      h['precedence']  || null,
                xMailer:         h['x-mailer']    || null,
                hasCampaignId:   !!(h['x-campaign-id'] || h['x-mailchimp-campaign-id'] || h['x-mc-eid']),
              },
              mailbox: 'INBOX',
            };
            return { msg, emailData, result: classifyByRules(emailData) };
          });

          // Anything the rules couldn't decide falls to the LLM — try one batched call first
          // (cheaper + faster, especially for a single local model), falling back to
          // concurrent per-email calls if the batch response doesn't parse cleanly.
          const needsLLM = prepared.filter(item => !item.result);
          if (needsLLM.length) {
            const batchResults = await classifyBatchWithLLM(needsLLM.map(item => item.emailData), log);
            if (batchResults) {
              needsLLM.forEach((item, i) => { item.result = batchResults[i]; });
            } else {
              await mapLimit(needsLLM, PARALLEL_WORKERS, async item => {
                item.result = await classifyWithLLM(item.emailData, log);
              });
            }
          }

          // Bucket results in original order (cheap, keeps activity feed/state mutation deterministic).
          for (const { msg, emailData, result } of prepared) {
            const from = emailData.from || emailData.fromName;

            if (result?.action === 'move') {
              if (!toMove.has(result.folder)) toMove.set(result.folder, []);
              toMove.get(result.folder).push(msg.uid);
              state.process.moved++;
              state.stats.folders[result.folder] = (state.stats.folders[result.folder] || 0) + 1;
              addActivity({ uid: msg.uid, from, subject: emailData.subject, action: 'move', folder: result.folder, source: result.source });

            } else if (result?.action === 'delete') {
              toDelete.push(msg.uid);
              state.process.deleted++;
              addActivity({ uid: msg.uid, from, subject: emailData.subject, action: 'delete', reason: result.reason, source: result.source });

            } else {
              toSave.push({ uid: msg.uid, envelope: msg.envelope });
              state.process.saved++;
              addActivity({ uid: msg.uid, from, subject: emailData.subject, action: 'save', source: result?.source || 'unclassified' });
            }
          }

          // ── Move to folder (messageMove = COPY + store \Deleted + EXPUNGE) ──
          for (const [folder, uids] of toMove) {
            try {
              await client.messageMove(uids.join(','), folder, { uid: true });
            } catch (err) {
              log('warn', `Move →${folder} failed: ${err.message}`);
            }
          }

          // ── Delete (rule-based deletes) ────────────────────────────────
          if (toDelete.length) {
            try {
              await client.messageDelete(toDelete.join(','), { uid: true });
            } catch (err) {
              log('warn', `Delete failed: ${err.message}`);
            }
          }

          // ── Download unclassified → mbox → delete from INBOX ──────────
          const savedUids = [];
          await mapLimit(toSave, PARALLEL_WORKERS, async item => {
            try {
              const dl = await client.download(item.uid, undefined, { uid: true });
              const chunks = [];
              for await (const chunk of dl.content) chunks.push(chunk);
              await appendToMbox(Buffer.concat(chunks), item.envelope);
              savedUids.push(item.uid);
            } catch (err) {
              log('warn', `Download uid ${item.uid}: ${err.message}`);
            }
          });
          if (savedUids.length) {
            try {
              await client.messageDelete(savedUids.join(','), { uid: true });
            } catch (err) {
              log('warn', `Delete after save: ${err.message}`);
            }
          }

          // ── Update progress ────────────────────────────────────────────
          sessionDone   += msgs.length;
          progress.done += msgs.length;
          state.process.done = Math.min(progress.total, progress.done);
          saveProgress(progress);
          recordRateSample();
          const { perSec, etaSeconds } = computeRate();

          const grandDone      = totalSessionDone + sessionDone;
          const grandRemaining = grandTotal !== null ? Math.max(0, grandTotal - grandDone) : null;
          const grandEtaSeconds = grandRemaining !== null && perSec > 0 ? Math.round(grandRemaining / perSec) : null;
          state.process.grandTotal     = grandTotal;
          state.process.grandRemaining = grandRemaining;

          broadcast('progress', {
            done:       state.process.done,
            total:      state.process.total,
            moved:      state.process.moved,
            deleted:    state.process.deleted,
            saved:      state.process.saved,
            perSec,
            etaSeconds,
            grandTotal,
            grandRemaining,
            grandEtaSeconds,
          });
          broadcast('stats', state.stats);

          // Brief pause between batches to avoid Yahoo IMAP rate limiting
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
      } finally {
        lock.release();
      }

      totalSessionDone += sessionDone;

      // If Yahoo returned fewer than 10k, we've seen everything
      if (_aborted || remaining < 10000) break;

      log('info', `Pass ${passCount} complete (${sessionDone.toLocaleString()} processed) — searching for more…`);
    }

    if (!_aborted) {
      state.process.status = 'done';
      state.process.currentAction = '';
      const passNote = passCount > 1 ? ` across ${passCount} passes` : '';
      log('info', `Complete — ${totalSessionDone.toLocaleString()} emails processed this session${passNote}.`);
    }

  } catch (err) {
    state.process.status = 'error';
    state.process.currentAction = '';
    state.error = err.message;
    log('error', `Error: ${err.message}`);
  } finally {
    _client = null;
    await client.logout().catch(() => {});
    broadcast('status', { process: state.process });
  }
}

// ── Controls ─────────────────────────────────────────────────────────────────
function pause() {
  setPaused(true);
  state.process.status = 'paused';
  broadcast('status', { process: state.process });
}

function resume() {
  setPaused(false);
  state.process.status = 'running';
  broadcast('status', { process: state.process });
}

function stop() {
  _aborted = true;
  setPaused(false);
  state.process.status = 'stopped';
  state.process.currentAction = '';
  broadcast('status', { process: state.process });
}

async function shutdown() {
  _aborted = true;
  setPaused(false);
  if (_client) {
    await _client.logout().catch(() => {});
    _client = null;
  }
}

function isRunning() { return _client !== null; }

async function testConnection(email, password) {
  const client = new ImapFlow({
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.logout();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { start, pause, resume, stop, shutdown, isRunning, testConnection };
