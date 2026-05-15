# OpenAI Realtime WebRTC Demo

Local Node + browser demo for OpenAI **Realtime** over **WebRTC**:

- **Live translation** - `gpt-realtime-translate` (WebRTC to `/v1/realtime/translations/calls` after a server-minted `client_secret`). Source transcription uses **`gpt-realtime-whisper`**. Guide: https://developers.openai.com/api/docs/guides/realtime-translation
- **Voice assistant** - `gpt-realtime-2` on `/v1/realtime/calls` (multipart `sdp` + `session`), sample **`check_calendar`** tool.

UI includes light/dark theme; assets under `public/brand/`.

## Requirements

- Node.js 20+
- Chrome or Edge
- OpenAI API key with Realtime model access

## Setup

1. `cp .env.example .env` (Windows: `Copy-Item .env.example .env`)
2. Set `OPENAI_API_KEY=sk-...` in `.env` (never commit `.env`)
3. Optional: `OPENAI_SAFETY_IDENTIFIER`, `PORT` (default **8787**)

## Run

```bash
npm install
npm start
```

Open http://localhost:8787

## Server routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/translation/client-secret` | Body `{"targetLanguage":"fr"}` -> OpenAI `client_secrets` for translate + whisper transcription |
| POST | `/api/realtime/call` | Body `{"sdp":"..."}` -> multipart to `/v1/realtime/calls` for `gpt-realtime-2` |

## Translation targets

`en`, `es`, `fr`, `de`, `it`, `pt`, `ja`, `ko`, `zh`, `ru`, `hi`, `id`, `vi`

## Security

Keep the API key on the server only. Local testing only.

## Related: Chrome extension (separate repo)

**Tab Hear Translate** lives in a sibling folder / repo: [`tab-hear-translate`](../tab-hear-translate) — captures **another Chrome tab’s audio** and runs live translation in-extension (BYOK). This web demo does **not** include that extension; use the other project for tab capture.

## Links

- https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/
- https://developers.openai.com/api/docs/guides/realtime-translation

## If README looks broken (VS Code / GitHub)

The file must be **UTF-8** (not UTF-16). In VS Code: click encoding bottom right -> Reopen with Encoding -> UTF-8, then Save with Encoding -> UTF-8.

## License

Demo / internal use; set a license if you republish.
