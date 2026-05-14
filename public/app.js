function logLine(el, msg) {
  el.textContent += `${new Date().toISOString().slice(11, 19)} ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function appendTranscript(el, chunk) {
  if (!chunk) return;
  el.textContent += chunk;
  el.scrollTop = el.scrollHeight;
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
    audioEl.srcObject = e.streams[0];
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
  if (assistantPc) {
    assistantPc.getSenders().forEach((s) => s.track?.stop());
    assistantPc.close();
    assistantPc = null;
  }
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

/** OpenAI browser translation demo uses raw capture constraints so DSP does not gate the send track. */
async function getTranslationMicStream(raw) {
  const audio = raw
    ? {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    : {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
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
  const rawMic = document.getElementById("translation-raw-mic").checked;

  resetTranslateIdleOverlays();

  logEl.textContent = "";
  srcEl.textContent = "";
  outEl.textContent = "";

  const btn = document.getElementById("btn-translate");
  const stopBtn = document.getElementById("btn-stop-translate");
  const rawCheckbox = document.getElementById("translation-raw-mic");
  btn.disabled = true;
  stopBtn.disabled = true;
  rawCheckbox.disabled = true;

  const secretRes = await fetch("/api/translation/client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: targetRaw }),
  });
  const secretJson = await secretRes.json().catch(() => ({}));
  if (!secretRes.ok) {
    logLine(logEl, `client_secret error: ${JSON.stringify(secretJson)}`);
    btn.disabled = false;
    stopBtn.disabled = true;
    rawCheckbox.disabled = false;
    return;
  }
  const clientSecret =
    secretJson.value ||
    secretJson.client_secret?.value ||
    (typeof secretJson.client_secret === "string" ? secretJson.client_secret : null);
  if (!clientSecret) {
    logLine(logEl, `unexpected client secret payload: ${JSON.stringify(secretJson)}`);
    btn.disabled = false;
    stopBtn.disabled = true;
    rawCheckbox.disabled = false;
    return;
  }

  let ms;
  try {
    ms = await getTranslationMicStream(rawMic);
  } catch (e) {
    logLine(logEl, `getUserMedia failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
    stopBtn.disabled = true;
    rawCheckbox.disabled = false;
    return;
  }

  translateLocalStream = ms;
  for (const t of ms.getAudioTracks()) {
    t.addEventListener("mute", () => logLine(logEl, "mic track muted (browser gating — try Raw mic + headphones)"));
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
  pc.ontrack = ({ streams }) => {
    audioEl.srcObject = streams[0];
    void audioEl.play().catch((err) => logLine(logEl, `remote audio play: ${err.message}`));
  };

  for (const track of ms.getTracks()) {
    pc.addTrack(track, ms);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });
  const answerText = await sdpRes.text();
  if (!sdpRes.ok) {
    logLine(logEl, `translations/calls ${sdpRes.status}: ${answerText}`);
    stopLiveTranslate();
    return;
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answerText });
  logLine(
    logEl,
    `connected (gpt-realtime-translate). Raw mic=${rawMic} — matches OpenAI cookbook capture tuning.`
  );
}

function stopLiveTranslate() {
  const btn = document.getElementById("btn-translate");
  const stopBtn = document.getElementById("btn-stop-translate");
  const rawCheckbox = document.getElementById("translation-raw-mic");
  resetTranslateIdleOverlays();
  if (translatePc) {
    translatePc.getSenders().forEach((s) => s.track?.stop());
    translatePc.close();
    translatePc = null;
  }
  translateLocalStream?.getTracks().forEach((t) => t.stop());
  translateLocalStream = null;
  btn.disabled = false;
  stopBtn.disabled = true;
  rawCheckbox.disabled = false;
}

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
