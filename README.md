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
2. Set your key in `.env` (never commit `.env`). The server reads **`OPENAI_API_KEY` first**, then **`realtime`**:

   ```env
   OPENAI_API_KEY=sk-...
   ```

   or:

   ```env
   realtime=sk-...
   ```

3. **Vercel:** add **`OPENAI_API_KEY`** (recommended) or **`realtime`** (same value), mark Sensitive, then **Redeploy**. Easiest fix if something still fails: set **both** to the same key.

4. **Monorepo:** this app lives in folder `openai-realtime-webrtc-dem`. In Vercel → Project → Settings → **Root Directory**, set **`openai-realtime-webrtc-dem`**. If this is wrong, Vercel may deploy another app or an old layout and your env + `server.js` updates will not match what runs in production.

5. Optional: `OPENAI_SAFETY_IDENTIFIER`, `PORT` (default **8787**)

## Run

```bash
npm install
npm start
```

Open http://localhost:8787

## Server routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Returns whether an API key is visible to the server (no secret values). Use on Vercel to debug env. |
| POST | `/api/translation/client-secret` | Body `{"targetLanguage":"fr"}` -> OpenAI `client_secrets` for translate + whisper transcription |
| POST | `/api/realtime/call` | Body `{"sdp":"..."}` -> multipart to `/v1/realtime/calls` for `gpt-realtime-2` |

## Translation targets

`en`, `es`, `fr`, `de`, `it`, `pt`, `ja`, `ko`, `zh`, `ru`, `hi`, `id`, `vi`

## Security

Keep the API key on the server only. Local testing only.

### Vercel 500 `missing API key` but the variable is set

1. Open `https://<your-deployment>/api/health` — if `openaiKeyConfigured` is false, the running function does not see `OPENAI_API_KEY` or `realtime` (wrong **Root Directory**, wrong project, or env not applied — redeploy after saving env).
2. If the error text still says exactly `Server missing OPENAI_API_KEY` with no extra sentence, production is still running an **old** `server.js`; check the deployment **Git commit** matches your latest push.

## Related: Chrome extension (separate repo)

**Tab Hear Translate** lives in a sibling folder / repo: [`tab-hear-translate`](../tab-hear-translate) — captures **another Chrome tab’s audio** and runs live translation in-extension (BYOK). This web demo does **not** include that extension; use the other project for tab capture.

## Links

- https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/
- https://developers.openai.com/api/docs/guides/realtime-translation

## If README looks broken (VS Code / GitHub)

The file must be **UTF-8** (not UTF-16). In VS Code: click encoding bottom right -> Reopen with Encoding -> UTF-8, then Save with Encoding -> UTF-8.

## License

Demo / internal use; set a license if you republish.
