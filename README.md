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
cp .env.example .env   # fill in YAHOO_EMAIL / YAHOO_APP_PASSWORD (Yahoo → Security → App Passwords)
npm start
```

Open `http://localhost:3333`.

## Performance

Processed **130,000 emails in ~12 hours** using `gpt-oss:20b` via Ollama on an
M1 Max (64GB) for the LLM fallback path — most emails were resolved by rules
alone; only unclassified emails hit the LLM.
