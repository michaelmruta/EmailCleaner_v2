# EmailCleaner v2

Yahoo inbox cleanup tool — sorts, moves, and deletes email in real time using a
rule engine (domain/keyword/subject/header matching) with an LLM fallback for
anything the rules can't confidently classify.

## Features

- Rule-based classification (`config/folders.js`) — domains, sender keywords,
  subject patterns, and header signals (List-Unsubscribe, Precedence, marketing
  mailer detection).
- LLM fallback for unclassified emails, batched per request, with a settings
  UI to switch provider/model live:
  - Ollama (local, free, auto-detects installed models)
  - OpenAI
  - Anthropic
  - OpenRouter
- Real-time dashboard (SSE) with live activity feed, folder breakdown, and
  console log.
- Throughput and ETA tracking — live emails/sec, elapsed time, and a
  continuous whole-inbox countdown (not capped by Yahoo's 10k search limit).
- Pause/resume/stop with progress persisted across restarts.

## Setup

```bash
npm install
cp .env.example .env   # fill in YAHOO_EMAIL / YAHOO_APP_PASSWORD
npm start
```

Open `http://localhost:3333`.

### Getting a Yahoo App Password

Yahoo requires an app-specific password for IMAP access — your regular
account password won't work, and 2-step verification must be enabled first.

1. Go to [Yahoo Account Security](https://login.yahoo.com/account/security).
2. Enable **2-Step Verification** if it isn't already on.
3. Click **Generate app password** (under "App passwords").
4. Give it a name (e.g. `EmailCleaner`) and click **Generate**.
5. Copy the 16-character password shown and paste it into `.env` as
   `YAHOO_APP_PASSWORD` — Yahoo only shows it once.

## Performance

Processed **130,000 emails in ~12 hours** using `gpt-oss:20b` via Ollama on an
M1 Max (64GB) for the LLM fallback path — most emails were resolved by rules
alone; only unclassified emails hit the LLM.

LLM batch size is 10 (`LLM_POOL_SIZE` in `src/processor.js`). Benchmarking
`gpt-oss:20b` on batched classification requests found batches of 15/20/25/30
reliably return one result per email, but 35+ silently drops 1-2 items (the
model loses track of the list, not a token-budget truncation) — 10 keeps margin
below that ceiling.
