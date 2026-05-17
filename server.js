import "dotenv/config";
import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAI_BASE = "https://api.openai.com";

/**
 * API key from env. Tries several names; skips empty strings (Vercel + dotenv edge cases).
 * Prefer `OPENAI_API_KEY` on Vercel (standard) or `realtime` if you named it that in the dashboard.
 */
function getOpenAIApiKey() {
  const names = ["OPENAI_API_KEY", "realtime"];
  for (const name of names) {
    const v = process.env[name];
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return "";
}

const missingKeyHint =
  "Set env `OPENAI_API_KEY` or `realtime` on Vercel (Project → Settings → Environment Variables), then redeploy. For local dev, use `.env`.";

const app = express();
const port = Number(process.env.PORT) || 8787;

app.use(express.json({ limit: "2mb" }));
app.use("/", express.static(join(__dirname, "public")));

/** Debug: confirms env is visible to the serverless function (never returns the secret). */
app.get("/api/health", (_req, res) => {
  const key = getOpenAIApiKey();
  res.json({
    ok: true,
    openaiKeyConfigured: Boolean(key),
    hasEnvRealtime: Boolean(process.env.realtime?.trim()),
    hasEnvOpenAIKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
    vercel: Boolean(process.env.VERCEL),
  });
});

/** gpt-realtime-2 voice agent: multipart sdp + session to /v1/realtime/calls */
function buildAssistantSessionJson() {
  return JSON.stringify({
    type: "realtime",
    model: "gpt-realtime-2",
    reasoning: { effort: "medium" },
    instructions:
      "You are a concise voice assistant. You can check calendar availability with check_calendar when the user asks about scheduling.",
    audio: {
      input: {
        turn_detection: { type: "server_vad" },
      },
      output: { voice: "marin" },
    },
  });
}

/** Assistant WebRTC (gpt-realtime-2) */
app.post("/api/realtime/call", async (req, res) => {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return res.status(500).type("text/plain").send(`Server missing API key. ${missingKeyHint}`);
  }

  const sdpOffer = typeof req.body?.sdp === "string" ? req.body.sdp : "";
  if (!sdpOffer.trim()) {
    return res.status(400).type("text/plain").send('Expected JSON body { "sdp": "..." }');
  }

  const fd = new FormData();
  fd.set("sdp", sdpOffer);
  fd.set("session", buildAssistantSessionJson());

  const headers = { Authorization: `Bearer ${apiKey}` };
  const safety = process.env.OPENAI_SAFETY_IDENTIFIER;
  if (safety) headers["OpenAI-Safety-Identifier"] = safety;

  let upstream;
  try {
    upstream = await fetch(`${OPENAI_BASE}/v1/realtime/calls`, {
      method: "POST",
      headers,
      body: fd,
    });
  } catch (e) {
    console.error(e);
    return res.status(502).type("text/plain").send("Upstream fetch failed");
  }

  const answerSdp = await upstream.text();
  if (!upstream.ok) {
    console.error("OpenAI /v1/realtime/calls error:", upstream.status, answerSdp);
    return res.status(upstream.status).type("text/plain").send(answerSdp);
  }

  res.status(200).type("application/sdp").send(answerSdp);
});

/** Output language codes for gpt-realtime-translate (OpenAI cookbook browser demo). */
const SUPPORTED_TRANSLATION_LANGUAGES = new Set([
  "es",
  "pt",
  "fr",
  "ja",
  "ru",
  "zh",
  "de",
  "ko",
  "hi",
  "id",
  "vi",
  "it",
  "en",
]);

function normalizeTargetLanguage(raw) {
  const code = String(raw ?? "").trim().toLowerCase();
  if (!code) return "es";
  if (SUPPORTED_TRANSLATION_LANGUAGES.has(code)) return code;
  return null;
}

/**
 * Short-lived secret for browser WebRTC to /v1/realtime/translations/calls.
 * Live simultaneous translation uses gpt-realtime-translate (not gpt-realtime-2).
 * @see https://developers.openai.com/api/docs/guides/realtime-translation
 */
app.post("/api/translation/client-secret", async (req, res) => {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return res.status(500).json({ error: `Server missing API key. ${missingKeyHint}` });
  }
  const targetLanguage = normalizeTargetLanguage(req.body?.targetLanguage);
  if (targetLanguage === null) {
    return res.status(400).json({
      error: "Unsupported targetLanguage",
      supported: [...SUPPORTED_TRANSLATION_LANGUAGES].sort(),
    });
  }

  const body = JSON.stringify({
    session: {
      model: "gpt-realtime-translate",
      audio: {
        input: {
          transcription: { model: "gpt-realtime-whisper" },
          noise_reduction: null,
        },
        output: { language: targetLanguage },
      },
    },
  });

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const safety = process.env.OPENAI_SAFETY_IDENTIFIER;
  if (safety) headers["OpenAI-Safety-Identifier"] = safety;

  const r = await fetch(`${OPENAI_BASE}/v1/realtime/translations/client_secrets`, {
    method: "POST",
    headers,
    body,
  });

  const text = await r.text();
  res.status(r.status).type(r.headers.get("content-type") || "application/json").send(text);
});

app.listen(port, () => {
  if (!getOpenAIApiKey()) {
    console.warn(`Warning: OpenAI API key missing. ${missingKeyHint}`);
  }
  console.log(`Open http://localhost:${port}`);
});
