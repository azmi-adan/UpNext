/**
 * UpNext — Floor Scanner
 * Camera capture → /scan → animated HUD result
 */

"use strict";

// ═══════════════════ CONFIG ═══════════════════
const SCAN_INTERVAL_MIN = 800;   // ms
const SCAN_INTERVAL_MAX = 1200;  // ms
const JPEG_QUALITY      = 0.82;
const HISTORY_MAX       = 6;
const RESULT_DISPLAY_MS = 4000;

// ═══════════════════ DOM REFS ═══════════════════
const video        = document.getElementById("video");
const canvas       = document.getElementById("captureCanvas");
const ctx          = canvas.getContext("2d");
const reticle      = document.getElementById("reticle");
const resultBurst  = document.getElementById("resultBurst");
const burstFloor   = document.getElementById("burstFloor");
const scanBar      = document.getElementById("scanBar");
const scanLabel    = document.getElementById("scanLabel");
const scanFill     = document.getElementById("scanFill");
const scanCount    = document.getElementById("scanCount");
const lastFloor    = document.getElementById("lastFloor");
const confidence   = document.getElementById("confidence");
const latency      = document.getElementById("latency");
const statusDot    = document.getElementById("statusDot");
const tickerTrack  = document.getElementById("tickerTrack");
const footerTime   = document.getElementById("footerTime");

// ═══════════════════ STATE ═══════════════════
let scanTimer      = null;
let scanProgress   = 0;
let progressTimer  = null;
let totalScans     = 0;
let resultTimeout  = null;
let history        = loadHistory();

// ═══════════════════ CLOCK ═══════════════════
function tickClock() {
  const now = new Date();
  footerTime.textContent = now.toTimeString().slice(0, 8);
}
setInterval(tickClock, 1000);
tickClock();

// ═══════════════════ HISTORY PERSISTENCE ═══════════════════
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("upnext_history") || "[]");
  } catch { return []; }
}
function saveHistory() {
  try { localStorage.setItem("upnext_history", JSON.stringify(history)); } catch {}
}
function addToHistory(floor) {
  history.unshift({ floor, ts: Date.now() });
  if (history.length > HISTORY_MAX) history.pop();
  saveHistory();
  renderHistory();
}
function renderHistory() {
  tickerTrack.innerHTML = "";
  history.forEach((entry, i) => {
    const el = document.createElement("div");
    el.className = "ticker-item" + (i > 0 ? " old" : "");
    el.textContent = `FL ${String(entry.floor).padStart(2, "0")}`;
    tickerTrack.appendChild(el);
  });
}
renderHistory(); // restore on load

// ═══════════════════ CAMERA INIT ═══════════════════
async function startCamera() {
  setStatus("INITIALIZING…", "");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    video.srcObject = stream;
    await new Promise((res) => { video.onloadedmetadata = res; });
    statusDot.classList.add("active");
    setStatus("READY — POINT AT LCD", "READY");
    setTimeout(startScanLoop, 800);
  } catch (err) {
    setStatus("CAM ERROR: " + err.message, "ERROR");
    console.error("Camera error:", err);
  }
}

// ═══════════════════ STATUS HELPERS ═══════════════════
function setStatus(text, mode) {
  scanLabel.textContent = text;
  statusDot.classList.remove("active", "scanning");
  if (mode === "scanning") statusDot.classList.add("scanning");
  else if (mode !== "ERROR") statusDot.classList.add("active");
}

// ═══════════════════ PROGRESS BAR ═══════════════════
function startProgress(durationMs) {
  clearInterval(progressTimer);
  scanProgress = 0;
  const step = 100 / (durationMs / 50);
  progressTimer = setInterval(() => {
    scanProgress = Math.min(scanProgress + step, 100);
    scanFill.style.width = scanProgress + "%";
    if (scanProgress >= 100) clearInterval(progressTimer);
  }, 50);
}

// ═══════════════════ FRAME CAPTURE ═══════════════════
function captureFrame() {
  const vw = video.videoWidth  || video.clientWidth;
  const vh = video.videoHeight || video.clientHeight;
  canvas.width  = vw;
  canvas.height = vh;
  ctx.drawImage(video, 0, 0, vw, vh);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

// ═══════════════════ SCAN LOOP ═══════════════════
function startScanLoop() {
  scheduleScan();
}

function scheduleScan() {
  const delay = SCAN_INTERVAL_MIN +
    Math.random() * (SCAN_INTERVAL_MAX - SCAN_INTERVAL_MIN);
  scanTimer = setTimeout(doScan, delay);
  startProgress(delay);
}

async function doScan() {
  if (!video.srcObject) { scheduleScan(); return; }

  setStatus("SCANNING…", "scanning");
  const t0     = performance.now();
  const frame  = captureFrame();

  totalScans++;
  updateStat(scanCount, String(totalScans).padStart(3, "0"));

  try {
    const resp = await fetch("/scan", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ image: frame })
    });

    const latMs = Math.round(performance.now() - t0);
    updateStat(latency, latMs + "ms");

    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const data = await resp.json();

    if (data.floor && data.floor.length > 0) {
      const floor = data.floor;
      const conf  = Math.min(99, Math.max(60,
        Math.round(100 - (latMs / 50))));   // heuristic confidence

      updateStat(lastFloor, "FL " + floor);
      updateStat(confidence, conf + "%");

      showResult(floor);
      addToHistory(floor);
      setStatus("FLOOR DETECTED: " + floor, "active");
    } else {
      setStatus("NO DIGIT FOUND — RETRY", "active");
      flashError();
    }
  } catch (err) {
    setStatus("NET ERROR — RETRYING", "active");
    console.warn("Scan error:", err);
    flashError();
  }

  scheduleScan();
}

// ═══════════════════ RESULT ANIMATION ═══════════════════
function showResult(floor) {
  // Clear any pending fade
  clearTimeout(resultTimeout);
  resultBurst.classList.remove("pop", "fade-out");

  // Force reflow to restart animation
  void resultBurst.offsetWidth;

  burstFloor.textContent = floor;
  resultBurst.classList.add("pop");
  reticle.classList.add("locked");
  document.body.classList.add("glitch");

  // Trigger glitch on the video element
  video.classList.add("glitch");
  setTimeout(() => {
    video.classList.remove("glitch");
    document.body.classList.remove("glitch");
  }, 320);

  resultTimeout = setTimeout(() => {
    resultBurst.classList.remove("pop");
    resultBurst.classList.add("fade-out");
    reticle.classList.remove("locked");
    setTimeout(() => resultBurst.classList.remove("fade-out"), 650);
  }, RESULT_DISPLAY_MS);
}

// ═══════════════════ STAT FLASH ═══════════════════
function updateStat(el, value) {
  el.textContent = value;
  el.classList.remove("updated");
  void el.offsetWidth;
  el.classList.add("updated");
}

// ═══════════════════ ERROR FLASH ═══════════════════
function flashError() {
  document.body.classList.remove("error-flash");
  void document.body.offsetWidth;
  document.body.classList.add("error-flash");
  setTimeout(() => document.body.classList.remove("error-flash"), 500);
}

// ═══════════════════ BOOT ═══════════════════
startCamera();