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

/* ---------- Bilingual conversation (2 × gpt-realtime-translate) ---------- */

let convMicStream = null;
let convMicTrack = null;
let convPttMode = "auto";
let convToThem = null;
let convToMe = null;
const convLiveTimers = new Map();

function languageLabel(code) {
  const name = LANGUAGE_LABELS[code] || code;
  return `${name} (${code})`;
}

function updateConversationLabels(myLang, theirLang) {
  const forThem = document.getElementById("conv-label-for-them");
  const forMe = document.getElementById("conv-label-for-me");
  if (forThem) forThem.textContent = `Pour l’autre — ${languageLabel(theirLang)}`;
  if (forMe) forMe.textContent = `Pour moi — ${languageLabel(myLang)}`;
}

function getConversationVolume() {
  const el = document.getElementById("conv-volume");
  const v = el ? Number(el.value) : 0.85;
  return Number.isFinite(v) ? v : 0.85;
}

function applyConversationVolume() {
  const v = getConversationVolume();
  for (const id of ["remote-audio-conv-for-them", "remote-audio-conv-for-me"]) {
    const el = document.getElementById(id);
    if (el) el.volume = v;
  }
}

function pulseConversationCard(cardEl) {
  if (!cardEl) return;
  cardEl.classList.add("subtitle-card--live");
  const prev = convLiveTimers.get(cardEl);
  if (prev) clearTimeout(prev);
  convLiveTimers.set(
    cardEl,
    setTimeout(() => {
      cardEl.classList.remove("subtitle-card--live");
      convLiveTimers.delete(cardEl);
    }, 1200)
  );
}

function setConversationPttMode(mode) {
  convPttMode = mode;
  document.querySelectorAll(".ptt__btn").forEach((btn) => {
    const on = btn.dataset.ptt === mode;
    btn.classList.toggle("ptt__btn--active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  applyConversationMicRouting();
}

function applyConversationMicRouting() {
  if (!convToThem?.sender || !convToMe?.sender) return;
  const toThemTrack = convPttMode === "them" ? null : convToThem.micTrack;
  const toMeTrack = convPttMode === "me" ? null : convToMe.micTrack;
  void convToThem.sender.replaceTrack(toThemTrack);
  void convToMe.sender.replaceTrack(toMeTrack);
}

async function connectConversationSession({
  clientSecret,
  micTrack,
  audioEl,
  logEl,
  outEl,
  cardEl,
  label,
}) {
  const pc = new RTCPeerConnection();
  const stream = new MediaStream([micTrack.clone()]);
  const sender = pc.addTrack(stream.getAudioTracks()[0], stream);

  const dc = pc.createDataChannel("oai-events");
  dc.addEventListener("message", (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "error" || data.type === "invalid_request_error") {
      logLine(logEl, `[${label}] error: ${JSON.stringify(data)}`);
      return;
    }
    if (OUTPUT_TRANSCRIPT_EVENTS.has(data.type) && typeof data.delta === "string") {
      appendTranscript(outEl, data.delta);
      pulseConversationCard(cardEl);
    }
  });
  dc.addEventListener("open", () => logLine(logEl, `[${label}] oai-events open`));

  audioEl.srcObject = new MediaStream();
  pc.ontrack = (e) => {
    void attachRemoteAudioElement(audioEl, e.streams[0], logEl);
    applyConversationVolume();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const { ok, status, text } = await postTranslationSdp(clientSecret, offer.sdp);
  if (!ok) {
    throw new Error(`translations/calls ${status}: ${text}`);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: text });
  return { pc, sender, stream, micTrack: stream.getAudioTracks()[0] };
}

async function startConversation() {
  const logEl = document.getElementById("log-conversation");
  const btn = document.getElementById("btn-conversation");
  const stopBtn = document.getElementById("btn-stop-conversation");
  const myLang = document.getElementById("conv-my-lang")?.value || "fr";
  const theirLang = document.getElementById("conv-their-lang")?.value || "zh";

  if (myLang === theirLang) {
    logLine(logEl, "Choisissez deux langues différentes.");
    return;
  }

  stopLiveTranslate();
  stopAssistant();

  logEl.textContent = "";
  document.getElementById("conv-out-for-them").textContent = "";
  document.getElementById("conv-out-for-me").textContent = "";
  updateConversationLabels(myLang, theirLang);

  btn.disabled = true;
  stopBtn.disabled = true;

  let ms;
  try {
    ms = await getTranslationMicStream();
  } catch (e) {
    logLine(logEl, `getUserMedia failed: ${formatGetUserMediaError(e)}`);
    btn.disabled = false;
    return;
  }

  convMicStream = ms;
  convMicTrack = ms.getAudioTracks()[0] || null;
  if (!convMicTrack) {
    logLine(logEl, "Aucune piste micro.");
    ms.getTracks().forEach((t) => t.stop());
    convMicStream = null;
    btn.disabled = false;
    return;
  }

  const secretRes = await fetch("/api/translation/conversation-secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ myLanguage: myLang, theirLanguage: theirLang }),
  });
  const secretJson = await secretRes.json().catch(() => ({}));
  if (!secretRes.ok) {
    logLine(logEl, `conversation-secrets error: ${JSON.stringify(secretJson)}`);
    stopConversation();
    return;
  }

  const secretToThem = extractClientSecret(secretJson.toThem?.secret);
  const secretToMe = extractClientSecret(secretJson.toMe?.secret);
  if (!secretToThem || !secretToMe) {
    logLine(logEl, `unexpected secrets: ${JSON.stringify(secretJson)}`);
    stopConversation();
    return;
  }

  const audioForThem = document.getElementById("remote-audio-conv-for-them");
  const audioForMe = document.getElementById("remote-audio-conv-for-me");
  const outForThem = document.getElementById("conv-out-for-them");
  const outForMe = document.getElementById("conv-out-for-me");
  const cardForThem = document.getElementById("conv-card-for-them");
  const cardForMe = document.getElementById("conv-card-for-me");

  try {
    logLine(logEl, `sessions: vous → ${theirLang}, autre → ${myLang}`);
    convToThem = await connectConversationSession({
      clientSecret: secretToThem,
      micTrack: convMicTrack,
      audioEl: audioForThem,
      logEl,
      outEl: outForThem,
      cardEl: cardForThem,
      label: "pour l’autre",
    });
    convToMe = await connectConversationSession({
      clientSecret: secretToMe,
      micTrack: convMicTrack,
      audioEl: audioForMe,
      logEl,
      outEl: outForMe,
      cardEl: cardForMe,
      label: "pour moi",
    });
  } catch (err) {
    logLine(logEl, String(err instanceof Error ? err.message : err));
    stopConversation();
    return;
  }

  applyConversationMicRouting();
  applyConversationVolume();
  stopBtn.disabled = false;
  logLine(logEl, "conversation connectée — parlez tour à tour ou utilisez les boutons micro");
}

function stopConversation() {
  const btn = document.getElementById("btn-conversation");
  const stopBtn = document.getElementById("btn-stop-conversation");

  for (const session of [convToThem, convToMe]) {
    if (!session) continue;
    session.pc.getSenders().forEach((s) => s.track?.stop());
    session.stream?.getTracks().forEach((t) => t.stop());
    session.pc.close();
  }
  convToThem = null;
  convToMe = null;

  convMicStream?.getTracks().forEach((t) => t.stop());
  convMicStream = null;
  convMicTrack = null;

  for (const id of ["remote-audio-conv-for-them", "remote-audio-conv-for-me"]) {
    const el = document.getElementById(id);
    if (el) el.srcObject = null;
  }

  for (const card of convLiveTimers.keys()) {
    card.classList.remove("subtitle-card--live");
  }
  convLiveTimers.clear();

  btn.disabled = false;
  stopBtn.disabled = true;
}

document.querySelectorAll(".ptt__btn").forEach((btn) => {
  btn.addEventListener("click", () => setConversationPttMode(btn.dataset.ptt || "auto"));
});

document.getElementById("conv-volume")?.addEventListener("input", applyConversationVolume);
document.getElementById("conv-my-lang")?.addEventListener("change", () => {
  const my = document.getElementById("conv-my-lang")?.value;
  const their = document.getElementById("conv-their-lang")?.value;
  if (my && their) updateConversationLabels(my, their);
});
document.getElementById("conv-their-lang")?.addEventListener("change", () => {
  const my = document.getElementById("conv-my-lang")?.value;
  const their = document.getElementById("conv-their-lang")?.value;
  if (my && their) updateConversationLabels(my, their);
});

document.getElementById("btn-conversation")?.addEventListener("click", startConversation);
document.getElementById("btn-stop-conversation")?.addEventListener("click", stopConversation);

updateConversationLabels("fr", "zh");

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
