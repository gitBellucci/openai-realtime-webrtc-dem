const OPENAI_TRANSLATIONS_CALLS = "https://api.openai.com/v1/realtime/translations/calls";

const LANGUAGE_LABELS = {
  es: "Espagnol",
  pt: "Portugais",
  fr: "Français",
  ja: "Japonais",
  ru: "Russe",
  zh: "Chinois",
  de: "Allemand",
  ko: "Coréen",
  hi: "Hindi",
  id: "Indonésien",
  vi: "Vietnamien",
  it: "Italien",
  en: "Anglais",
};

function logLine(el, msg) {
  el.textContent += `${new Date().toISOString().slice(11, 19)} ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function extractClientSecret(json) {
  return (
    json?.value ||
    json?.client_secret?.value ||
    (typeof json?.client_secret === "string" ? json.client_secret : null)
  );
}

async function postTranslationSdp(clientSecret, sdp) {
  const r = await fetch(OPENAI_TRANSLATIONS_CALLS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: sdp,
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

function appendTranscript(el, chunk) {
  if (!chunk) return;
  el.textContent += chunk;
  el.scrollTop = el.scrollHeight;
}

/**
 * Remote tracks arrive after the click handler stack unwinds; explicit play() avoids muted / deferred
 * playback. Keeps volume at default unity — same perceived level as a normal media element.
 */
async function attachRemoteAudioElement(audioEl, stream, logEl) {
  audioEl.srcObject = stream;
  audioEl.muted = false;
  audioEl.volume = 1;
  try {
    await audioEl.play();
  } catch (err) {
    if (logEl) logLine(logEl, `remote audio play: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Assistant: gpt-realtime-2 via server multipart proxy */
async function postAssistantSdp(sdp) {
  const r = await fetch("/api/realtime/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sdp }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}

/* ---------- Assistant + calendar (gpt-realtime-2) ---------- */

const BUSY = new Set(["2026-05-15T14:00", "2026-05-15T15:00"]);

function checkCalendar(date, time) {
  const key = `${date}T${time}`;
  const available = !BUSY.has(key);
  return { available, message: available ? "Slot is open." : "That time is already booked." };
}

function registerCalendarTool(dc) {
  dc.send(
    JSON.stringify({
      type: "session.update",
      session: {
        model: "gpt-realtime-2",
        reasoning: { effort: "medium" },
        parallel_tool_calls: true,
        tools: [
          {
            type: "function",
            name: "check_calendar",
            description:
              "Return whether a calendar time slot is available. Use ISO date YYYY-MM-DD and 24h time HH:MM.",
            parameters: {
              type: "object",
              properties: {
                date: { type: "string", description: "Date in YYYY-MM-DD" },
                time: { type: "string", description: "Time in HH:MM (24h)" },
              },
              required: ["date", "time"],
            },
          },
        ],
        tool_choice: "auto",
      },
    })
  );
}

function handleAssistantMessage(dc, ev, logEl) {
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (data.type === "error" || data.type === "invalid_request_error") {
    logLine(logEl, `error: ${JSON.stringify(data)}`);
    return;
  }

  if (data.type === "response.done" && Array.isArray(data.response?.output)) {
    for (const item of data.response.output) {
      if (item.type !== "function_call" || item.name !== "check_calendar") continue;

      let args;
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch {
        args = {};
      }
      const result = checkCalendar(args.date, args.time);
      logLine(logEl, `tool check_calendar(${args.date}, ${args.time}) -> ${JSON.stringify(result)}`);

      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: item.call_id,
            output: JSON.stringify(result),
          },
        })
      );
      dc.send(JSON.stringify({ type: "response.create" }));
    }
  }
}

let assistantPc = null;

async function startAssistant() {
  const logEl = document.getElementById("log-assistant");
  const audioEl = document.getElementById("remote-audio-assistant");
  const btn = document.getElementById("btn-assistant");
  const stopBtn = document.getElementById("btn-stop-assistant");
  logEl.textContent = "";

  btn.disabled = true;
  stopBtn.disabled = false;

  const pc = new RTCPeerConnection();
  assistantPc = pc;

  const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of ms.getTracks()) pc.addTrack(t, ms);

  audioEl.srcObject = new MediaStream();
  pc.ontrack = (e) => {
    void attachRemoteAudioElement(audioEl, e.streams[0], logEl);
  };

  const dc = pc.createDataChannel("oai-events");
  dc.addEventListener("open", () => {
    logLine(logEl, "data channel open; session.update (tools)");
    registerCalendarTool(dc);
  });
  dc.addEventListener("message", (e) => handleAssistantMessage(dc, e, logEl));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  try {
    const answerSdp = await postAssistantSdp(offer.sdp || "");
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    logLine(logEl, "WebRTC connected (gpt-realtime-2)");
  } catch (err) {
    logLine(logEl, String(err));
    stopAssistant();
  }
}

function stopAssistant() {
  const btn = document.getElementById("btn-assistant");
  const stopBtn = document.getElementById("btn-stop-assistant");
  const audioEl = document.getElementById("remote-audio-assistant");
  if (assistantPc) {
    assistantPc.getSenders().forEach((s) => s.track?.stop());
    assistantPc.close();
    assistantPc = null;
  }
  if (audioEl) audioEl.srcObject = null;
  btn.disabled = false;
  stopBtn.disabled = true;
}

/* ---------- Live translation (gpt-realtime-translate) ---------- */

let translatePc = null;
let translateLocalStream = null;

function resetTranslateIdleOverlays() {
  const listen = document.getElementById("anim-listening");
  const trans = document.getElementById("anim-translating");
  if (listen) listen.hidden = true;
  if (trans) trans.hidden = true;
}

function showTranslateIdleOverlays() {
  const listen = document.getElementById("anim-listening");
  const trans = document.getElementById("anim-translating");
  if (listen) listen.hidden = false;
  if (trans) trans.hidden = false;
}

function formatGetUserMediaError(err) {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError" || /not allowed|denied permission/i.test(msg)) {
    return (
      `${msg}\n` +
      "→ Autorisez le micro (popup ou Réglages → Safari → Microphone).\n" +
      "→ Sur iPhone : quittez la navigation privée (Safari « Privée » bloque souvent le micro).\n" +
      "→ Relancez Démarrer après avoir autorisé."
    );
  }
  if (name === "NotFoundError") {
    return `${msg}\n→ Aucun micro détecté sur cet appareil.`;
  }
  if (name === "NotSupportedError" || !navigator.mediaDevices?.getUserMedia) {
    return `${msg}\n→ Micro non disponible dans ce navigateur ou ce contexte (essayez Safari/Chrome hors mode privé).`;
  }
  return msg;
}

async function getTranslationMicStream() {
  const simple = { audio: true, video: false };
  const rich = {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(rich);
  } catch (first) {
    if (first?.name === "OverconstrainedError" || first?.name === "NotSupportedError") {
      return navigator.mediaDevices.getUserMedia(simple);
    }
    throw first;
  }
}

const OUTPUT_TRANSCRIPT_EVENTS = new Set(["session.output_transcript.delta"]);
const INPUT_TRANSCRIPT_EVENTS = new Set(["session.input_transcript.delta"]);

function handleTranslateDataChannel(ev, logEl, srcEl, outEl) {
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (data.type === "error" || data.type === "invalid_request_error") {
    logLine(logEl, `error: ${JSON.stringify(data)}`);
    return;
  }

  if (OUTPUT_TRANSCRIPT_EVENTS.has(data.type) && typeof data.delta === "string") {
    appendTranscript(outEl, data.delta);
    return;
  }

  if (INPUT_TRANSCRIPT_EVENTS.has(data.type) && typeof data.delta === "string") {
    appendTranscript(srcEl, data.delta);
    return;
  }
}

async function startLiveTranslate() {
  const logEl = document.getElementById("log-translate");
  const srcEl = document.getElementById("src-transcript");
  const outEl = document.getElementById("out-transcript");
  const audioEl = document.getElementById("remote-audio-translate");
  const targetRaw = document.getElementById("target-lang").value || "es";

  resetTranslateIdleOverlays();

  logEl.textContent = "";
  srcEl.textContent = "";
  outEl.textContent = "";

  const btn = document.getElementById("btn-translate");
  const stopBtn = document.getElementById("btn-stop-translate");
  btn.disabled = true;
  stopBtn.disabled = true;

  // iOS Safari: getUserMedia must run in the same user-gesture turn as the tap.
  // Do not await network I/O before requesting the microphone.
  let ms;
  try {
    ms = await getTranslationMicStream();
  } catch (e) {
    logLine(logEl, `getUserMedia failed: ${formatGetUserMediaError(e)}`);
    btn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  translateLocalStream = ms;

  const secretRes = await fetch("/api/translation/client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: targetRaw }),
  });
  const secretJson = await secretRes.json().catch(() => ({}));
  if (!secretRes.ok) {
    logLine(logEl, `client_secret error: ${JSON.stringify(secretJson)}`);
    ms.getTracks().forEach((t) => t.stop());
    translateLocalStream = null;
    btn.disabled = false;
    stopBtn.disabled = true;
    return;
  }
  const clientSecret = extractClientSecret(secretJson);
  if (!clientSecret) {
    logLine(logEl, `unexpected client secret payload: ${JSON.stringify(secretJson)}`);
    ms.getTracks().forEach((t) => t.stop());
    translateLocalStream = null;
    btn.disabled = false;
    stopBtn.disabled = true;
    return;
  }
  for (const t of ms.getAudioTracks()) {
    t.addEventListener("mute", () => logLine(logEl, "mic track muted (browser gating — try headphones)"));
    t.addEventListener("unmute", () => logLine(logEl, "mic track unmuted"));
  }

  const pc = new RTCPeerConnection();
  translatePc = pc;
  stopBtn.disabled = false;

  const dc = pc.createDataChannel("oai-events");
  dc.addEventListener("message", (e) => handleTranslateDataChannel(e, logEl, srcEl, outEl));
  dc.addEventListener("open", () => {
    logLine(logEl, "oai-events open (translation session)");
    showTranslateIdleOverlays();
  });

  pc.onconnectionstatechange = () => {
    logLine(logEl, `webrtc connectionState=${pc.connectionState}`);
  };
  pc.oniceconnectionstatechange = () => {
    logLine(logEl, `webrtc iceConnectionState=${pc.iceConnectionState}`);
  };

  audioEl.srcObject = new MediaStream();
  pc.ontrack = (e) => {
    void attachRemoteAudioElement(audioEl, e.streams[0], logEl);
  };

  for (const track of ms.getTracks()) {
    pc.addTrack(track, ms);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const { ok, status, text: answerText } = await postTranslationSdp(clientSecret, offer.sdp);
  if (!ok) {
    logLine(logEl, `translations/calls ${status}: ${answerText}`);
    stopLiveTranslate();
    return;
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answerText });
  logLine(logEl, "connected (gpt-realtime-translate)");
}

function stopLiveTranslate() {
  const btn = document.getElementById("btn-translate");
  const stopBtn = document.getElementById("btn-stop-translate");
  const audioEl = document.getElementById("remote-audio-translate");
  resetTranslateIdleOverlays();
  if (translatePc) {
    translatePc.getSenders().forEach((s) => s.track?.stop());
    translatePc.close();
    translatePc = null;
  }
  translateLocalStream?.getTracks().forEach((t) => t.stop());
  translateLocalStream = null;
  if (audioEl) audioEl.srcObject = null;
  btn.disabled = false;
  stopBtn.disabled = true;
}

/* ---------- Ping-pong conversation (hold side = one translation session) ---------- */

const pingPong = {
  side: null,
  generation: 0,
  starting: false,
  pc: null,
  micStream: null,
};

function languageLabel(code) {
  const name = LANGUAGE_LABELS[code] || code;
  return `${name} (${code})`;
}

function getPingPongLangs() {
  return {
    red: document.getElementById("pingpong-red-lang")?.value || "en",
    blue: document.getElementById("pingpong-blue-lang")?.value || "fr",
  };
}

function pingPongOutputLang(holdingSide) {
  const { red, blue } = getPingPongLangs();
  return holdingSide === "red" ? blue : red;
}

function pingPongUi(side) {
  return {
    half: document.getElementById(side === "red" ? "pingpong-red" : "pingpong-blue"),
    status: document.getElementById(side === "red" ? "pingpong-red-status" : "pingpong-blue-status"),
    out: document.getElementById(side === "red" ? "pingpong-red-out" : "pingpong-blue-out"),
    hint: document.getElementById(side === "red" ? "pingpong-red-hint" : "pingpong-blue-hint"),
  };
}

function setPingPongStatus(side, text) {
  const { status } = pingPongUi(side);
  if (status) status.textContent = text || "";
}

function setPingPongHalfActive(side, on) {
  const { half } = pingPongUi(side);
  if (half) half.classList.toggle("pingpong__half--holding", on);
}

function updatePingPongHints() {
  const { red, blue } = getPingPongLangs();
  const redHint = document.getElementById("pingpong-red-hint");
  const blueHint = document.getElementById("pingpong-blue-hint");
  if (redHint) {
    redHint.textContent = `Maintenir · ${languageLabel(red)} → traduit en ${languageLabel(blue)}`;
  }
  if (blueHint) {
    blueHint.textContent = `Maintenir · ${languageLabel(blue)} → traduit en ${languageLabel(red)}`;
  }
}

function setPingPongLayout(active) {
  document.body.classList.toggle("pingpong-active", active);
  if (!active) teardownPingPongSession();
}

function teardownPingPongSession() {
  pingPong.generation += 1;
  pingPong.starting = false;
  const prev = pingPong.side;
  pingPong.side = null;
  if (prev) setPingPongHalfActive(prev, false);

  if (pingPong.pc) {
    pingPong.pc.getSenders().forEach((s) => s.track?.stop());
    pingPong.pc.close();
    pingPong.pc = null;
  }
  pingPong.micStream?.getTracks().forEach((t) => t.stop());
  pingPong.micStream = null;

  const audioEl = document.getElementById("remote-audio-pingpong");
  if (audioEl) audioEl.srcObject = null;

  if (prev) setPingPongStatus(prev, "");
}

async function pingPongHoldStart(side) {
  if (pingPong.side === side && pingPong.pc) return;
  if (pingPong.starting) return;

  const { red, blue } = getPingPongLangs();
  if (red === blue) {
    setPingPongStatus(side, "Choisissez deux langues différentes.");
    return;
  }

  stopLiveTranslate();
  stopAssistant();
  teardownPingPongSession();

  const gen = ++pingPong.generation;
  pingPong.starting = true;
  pingPong.side = side;
  setPingPongHalfActive(side, true);
  setPingPongStatus(side, "Connexion…");

  const outputLang = pingPongOutputLang(side);
  const logEl = document.getElementById("log-conversation");
  const audioEl = document.getElementById("remote-audio-pingpong");
  const { out } = pingPongUi(side);
  if (out) out.textContent = "";

  let ms;
  try {
    ms = await getTranslationMicStream();
  } catch (e) {
    if (gen !== pingPong.generation) return;
    setPingPongStatus(side, formatGetUserMediaError(e).split("\n")[0]);
    setPingPongHalfActive(side, false);
    pingPong.side = null;
    pingPong.starting = false;
    return;
  }

  if (gen !== pingPong.generation) {
    ms.getTracks().forEach((t) => t.stop());
    return;
  }
  pingPong.micStream = ms;

  const secretRes = await fetch("/api/translation/client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: outputLang }),
  });
  const secretJson = await secretRes.json().catch(() => ({}));
  const clientSecret = extractClientSecret(secretJson);

  if (gen !== pingPong.generation) {
    ms.getTracks().forEach((t) => t.stop());
    pingPong.micStream = null;
    return;
  }

  if (!secretRes.ok || !clientSecret) {
    setPingPongStatus(side, "Erreur session");
    if (logEl) logLine(logEl, `client_secret: ${JSON.stringify(secretJson)}`);
    teardownPingPongSession();
    return;
  }

  const pc = new RTCPeerConnection();
  pingPong.pc = pc;
  for (const track of ms.getTracks()) pc.addTrack(track, ms);

  const dc = pc.createDataChannel("oai-events");
  dc.addEventListener("message", (e) => {
    if (gen !== pingPong.generation || pingPong.side !== side) return;
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "error" || data.type === "invalid_request_error") {
      if (logEl) logLine(logEl, JSON.stringify(data));
      return;
    }
    if (OUTPUT_TRANSCRIPT_EVENTS.has(data.type) && typeof data.delta === "string" && out) {
      appendTranscript(out, data.delta);
    }
  });

  audioEl.srcObject = new MediaStream();
  pc.ontrack = (e) => {
    void attachRemoteAudioElement(audioEl, e.streams[0], logEl);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (gen !== pingPong.generation) throw new Error("cancelled");

    const { ok, status, text } = await postTranslationSdp(clientSecret, offer.sdp);
    if (!ok) throw new Error(`${status}: ${text}`);
    await pc.setRemoteDescription({ type: "answer", sdp: text });

    if (gen !== pingPong.generation) throw new Error("cancelled");
    pingPong.starting = false;
    setPingPongStatus(side, "Parlez…");
    if (logEl) logLine(logEl, `${side} → ${outputLang}`);
  } catch (err) {
    if (gen === pingPong.generation) {
      setPingPongStatus(side, "Échec connexion");
      if (logEl) logLine(logEl, String(err instanceof Error ? err.message : err));
      teardownPingPongSession();
    }
  }
}

function pingPongHoldEnd(side) {
  if (pingPong.side !== side && !pingPong.starting) return;
  teardownPingPongSession();
}

function bindPingPongHalf(el, side) {
  const select = el.querySelector(".pingpong__select");
  if (select) {
    for (const ev of ["pointerdown", "mousedown", "touchstart", "click"]) {
      select.addEventListener(ev, (e) => e.stopPropagation());
    }
  }

  el.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest(".pingpong__select")) return;
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ok */
      }
      void pingPongHoldStart(side);
    },
    { passive: false }
  );

  const release = (e) => {
    if (el.hasPointerCapture?.(e.pointerId)) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ok */
      }
    }
    pingPongHoldEnd(side);
  };

  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("lostpointercapture", () => pingPongHoldEnd(side));
}

const pingPongRed = document.getElementById("pingpong-red");
const pingPongBlue = document.getElementById("pingpong-blue");
if (pingPongRed) bindPingPongHalf(pingPongRed, "red");
if (pingPongBlue) bindPingPongHalf(pingPongBlue, "blue");

document.getElementById("pingpong-red-lang")?.addEventListener("change", updatePingPongHints);
document.getElementById("pingpong-blue-lang")?.addEventListener("change", updatePingPongHints);
updatePingPongHints();

/* ---------- Tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("tab--active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("panel--active", p.id === `panel-${id}`);
    });
    setPingPongLayout(id === "conversation");
    if (id !== "conversation") teardownPingPongSession();
  });
});

document.getElementById("btn-assistant").addEventListener("click", startAssistant);
document.getElementById("btn-stop-assistant").addEventListener("click", stopAssistant);
document.getElementById("btn-translate").addEventListener("click", startLiveTranslate);
document.getElementById("btn-stop-translate").addEventListener("click", stopLiveTranslate);

/* ---------- Theme (clair / sombre) ---------- */

const THEME_STORAGE_KEY = "phq-theme";

function syncThemeControls() {
  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  const btn = document.getElementById("theme-toggle");
  if (meta) {
    meta.setAttribute("content", theme === "dark" ? "#0c0c0f" : "#111111");
  }
  if (btn) {
    btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    btn.setAttribute(
      "aria-label",
      theme === "dark" ? "Activer le thème clair" : "Activer le thème sombre"
    );
    btn.title = theme === "dark" ? "Thème clair" : "Thème sombre";
  }
}

function applyTheme(next) {
  const t = next === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* private mode, etc. */
  }
  syncThemeControls();
}

document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  applyTheme(isDark ? "light" : "dark");
});

syncThemeControls();
