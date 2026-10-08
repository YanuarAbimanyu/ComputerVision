// ==========================================
// KONFIGURASI DATABASE
// ==========================================
// KOSONGKAN apiKey untuk menggunakan Mock Mode
// ISI apiKey untuk menggunakan Firebase Mode

const firebaseConfig = {
  apiKey: "AIzaSyCC_YjFLpmRnT_135F78sJe-GdBxVOz9AA",
  authDomain: "computervision-3c146.firebaseapp.com",
  projectId: "computervision-3c146",
  storageBucket: "computervision-3c146.firebasestorage.app",
  messagingSenderId: "97628487969",
  appId: "1:97628487969:web:0709b03734741c0fbd7e60",
};

// Kelas objek COCO-SSD yang ingin dideteksi
// (catatan: "pen" bukan kelas COCO, jadi dihapus)
const TARGET_CLASSES = [
  "mouse",
  "keyboard",
  "cell phone",
  "book",
  "scissors",
  "laptop",
  "person",
];
const MIN_CONFIDENCE = 0.6;

// ==========================================
// MOCK FIRESTORE
// (harus didefinisikan SEBELUM dipakai, karena class tidak di-hoist)
// ==========================================

class MockFirestore {
  constructor() {
    const saved = JSON.parse(localStorage.getItem("mock_inventory_db") || "[]");

    // Fungsi toDate hilang saat disimpan ke JSON, jadi dibuat ulang saat dimuat
    this.data = saved.map((d) => ({
      ...d,
      timestamp: this._makeTimestamp(d.timestamp),
    }));
    this.listeners = [];
  }

  _makeTimestamp(iso) {
    const date = iso ? new Date(iso) : new Date();
    return { iso: date.toISOString(), toDate: () => date };
  }

  _save() {
    // Simpan timestamp sebagai string ISO
    const plain = this.data.map((d) => ({ ...d, timestamp: d.timestamp.iso }));
    localStorage.setItem("mock_inventory_db", JSON.stringify(plain));
  }

  collection() {
    return this;
  }

  orderBy() {
    return this;
  }

  limit() {
    return this;
  }

  async add(payload) {
    const doc = {
      ...payload,
      id: Date.now().toString(),
      timestamp: this._makeTimestamp(),
    };

    this.data.unshift(doc);

    // Batasi maksimal 50 dokumen
    if (this.data.length > 50) this.data.pop();

    this._save();
    this.listeners.forEach((cb) => cb(this.data));

    return doc;
  }

  onSnapshot(cb) {
    this.listeners.push(cb);
    cb(this.data); // jalankan pertama kali

    // Fungsi unsubscribe
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
}

// ==========================================
// INISIALISASI DATABASE (Firebase atau Mock)
// ==========================================

let db;
let isMockMode = true;

function initDatabase() {
  const dbStatusEl = document.getElementById("db-status");

  // Pakai Firebase hanya jika apiKey terisi DAN library firebase sudah dimuat
  if (
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    typeof firebase !== "undefined"
  ) {
    try {
      // Cegah error "Firebase App named '[DEFAULT]' already exists"
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      db = firebase.firestore();
      isMockMode = false;

      if (dbStatusEl) {
        dbStatusEl.textContent = "Firebase online";
        dbStatusEl.className = "status-badge online";
      }
      console.log("Firebase berhasil terhubung.");
    } catch (e) {
      console.error("Firebase init error:", e);
      // Pastikan fallback ke mock jika Firebase gagal
      isMockMode = true;
    }
  }

  if (isMockMode) {
    db = new MockFirestore();

    if (dbStatusEl) {
      dbStatusEl.textContent = "Mode demo";
      dbStatusEl.className = "status-badge demo";
    }
    console.log("Menggunakan Mock Database.");
  }
}

// ==========================================
// ELEMEN & STATE UI
// ==========================================

const $ = (id) => document.getElementById(id);

const videoEl = $("video");
const canvasEl = $("canvas");
const ctx = canvasEl.getContext("2d");

const btnAI = $("btn-ai");
const btnCamera = $("btn-camera");
const btnFlash = $("btn-flash");
const btnSwitch = $("btn-switch");

// ------------------------------------------
// Toast
// ------------------------------------------
let toastTimer = null;

function showToast(message, type = "ok") {
  const el = $("toast");
  el.textContent = message;
  el.className = type === "warn" ? "toast warn" : "toast";
  el.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2500);
}

// ------------------------------------------
// Overlay status kamera (mati / menyalakan / error)
// ------------------------------------------
let cameraStatus = "off"; // "off" | "starting" | "on" | "error"
let cameraErrorText = "";

function renderOverlay() {
  const overlay = $("overlay-msg");
  const spinner = $("overlay-spinner");
  const title = $("overlay-title");
  const text = $("overlay-text");

  if (cameraStatus === "on") {
    overlay.hidden = true;
    return;
  }

  const content = {
    starting: { spin: true, title: "Menyalakan kamera…", text: "" },
    error: {
      spin: false,
      title: "Kamera tidak bisa dibuka",
      text: cameraErrorText,
    },
    off: {
      spin: false,
      title: "Kamera nonaktif",
      text: "Ketuk tombol Kamera untuk menyalakan.",
    },
  }[cameraStatus];

  spinner.hidden = !content.spin;
  title.textContent = content.title;
  text.textContent = content.text;
  overlay.hidden = false;
}

function setCameraStatus(status, errorText = "") {
  cameraStatus = status;
  cameraErrorText = errorText;
  renderOverlay();
  updateControlsUI();
}

// ==========================================
// KAMERA
// ==========================================

let currentStream = null;
let facingMode = "environment"; // kamera belakang dulu (cocok untuk scan inventaris)
let isCameraOn = false;
let isFrontCamera = false; // dipakai untuk mencerminkan video & bounding box
let cameraBusy = false; // cegah ketukan ganda saat kamera sedang diproses

let torchSupported = false;
let torchOn = false;

function cameraErrorMessage(err) {
  switch (err && err.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Izin kamera ditolak. Izinkan akses kamera di pengaturan browser, lalu ketuk tombol Kamera.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Kamera tidak ditemukan di perangkat ini.";
    case "NotReadableError":
      return "Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu, lalu coba lagi.";
    default:
      return "Pastikan halaman dibuka lewat HTTPS atau localhost.";
  }
}

// Cek apakah kamera yang aktif punya lampu flash (torch)
function detectTorchSupport(track) {
  let caps = {};
  try {
    caps = track.getCapabilities ? track.getCapabilities() : {};
  } catch (e) {
    caps = {};
  }
  torchSupported = !!caps.torch;
  torchOn = false;
  updateControlsUI();
}

// Mengembalikan true jika kamera berhasil menyala
async function startCamera() {
  stopCamera({ silent: true }); // pastikan stream lama benar-benar mati
  setCameraStatus("starting");

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("mediaDevices tidak tersedia");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // "ideal" (bukan "exact") supaya tetap jalan di laptop yang hanya punya 1 kamera
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};

    currentStream = stream;
    isFrontCamera = (settings.facingMode || facingMode) === "user";
    videoEl.classList.toggle("mirrored", isFrontCamera);

    // Jika kamera dicabut / diambil aplikasi lain di tengah jalan
    track.addEventListener("ended", () => {
      if (currentStream === stream && isCameraOn) {
        stopCamera();
        showToast("Kamera terputus.", "warn");
      }
    });

    videoEl.srcObject = stream;

    await new Promise((resolve) => {
      if (videoEl.readyState >= 1) return resolve();
      videoEl.onloadedmetadata = () => resolve();
    });

    await videoEl.play();
    isCameraOn = true;

    console.log(
      "Resolusi kamera:",
      videoEl.videoWidth,
      "x",
      videoEl.videoHeight,
    );

    resizeCanvas();
    detectTorchSupport(track);
    setCameraStatus("on");

    // Jika AI sedang aktif (misal habis ganti kamera), lanjutkan deteksi
    if (isAIDetecting) detectLoop();

    console.log("Kamera berhasil dinyalakan!");
    return true;
  } catch (err) {
    console.error("Gagal akses kamera:", err);
    stopCamera({ silent: true });
    setCameraStatus("error", cameraErrorMessage(err));
    return false;
  }
}

// silent: true => jangan ubah tampilan overlay (dipakai saat restart kamera)
function stopCamera({ silent = false } = {}) {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  videoEl.srcObject = null;

  isCameraOn = false;
  torchOn = false;
  torchSupported = false;
  clearCanvas();

  if (!silent) setCameraStatus("off");
}

// ------------------------------------------
// Tombol: nyalakan / matikan kamera
// ------------------------------------------
async function handleCameraToggle() {
  if (cameraBusy) return;
  cameraBusy = true;

  try {
    if (isCameraOn) {
      setAI(false); // tanpa kamera, AI tidak ada yang dianalisis
      stopCamera();
    } else {
      await startCamera();
    }
  } finally {
    cameraBusy = false;
  }
}

// ------------------------------------------
// Tombol: flash (torch)
// ------------------------------------------
async function handleFlashToggle() {
  if (cameraBusy) return;

  if (!isCameraOn) {
    showToast("Nyalakan kamera dulu.", "warn");
    return;
  }

  if (!torchSupported) {
    showToast(
      isFrontCamera
        ? "Kamera depan tidak punya flash."
        : "Browser atau perangkat ini tidak mendukung flash.",
      "warn",
    );
    return;
  }

  const track = currentStream && currentStream.getVideoTracks()[0];
  if (!track) return;

  try {
    await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    updateControlsUI();
  } catch (err) {
    console.error("Gagal mengubah flash:", err);
    showToast("Flash tidak bisa dinyalakan.", "warn");
  }
}

// ------------------------------------------
// Tombol: ganti kamera depan / belakang
// ------------------------------------------
async function handleSwitchCamera() {
  if (cameraBusy) return;
  cameraBusy = true;

  // animasi putar singkat pada ikon
  btnSwitch.classList.remove("spinning");
  void btnSwitch.offsetWidth; // restart animasi
  btnSwitch.classList.add("spinning");

  try {
    // Perangkat dengan 1 kamera (kebanyakan laptop) tidak bisa ganti
    let cameraCount = 2;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameraCount = devices.filter((d) => d.kind === "videoinput").length;
    } catch (e) {
      /* abaikan, anggap bisa ganti */
    }
    if (cameraCount < 2) {
      showToast("Perangkat ini hanya punya satu kamera.", "warn");
      return;
    }

    const previous = facingMode;
    facingMode = facingMode === "environment" ? "user" : "environment";
    updateControlsUI();

    // Kamera sedang mati: cukup simpan pilihan, dipakai saat kamera dinyalakan
    if (!isCameraOn) return;

    const ok = await startCamera();
    if (!ok) {
      // Gagal pindah: kembali ke kamera sebelumnya
      facingMode = previous;
      await startCamera();
      showToast("Gagal mengganti kamera.", "warn");
    }
  } finally {
    cameraBusy = false;
  }
}

// ==========================================
// CANVAS (ukuran mengikuti layar, tajam di layar retina)
// ==========================================

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvasEl.clientWidth;
  const h = canvasEl.clientHeight;
  if (!w || !h) return;

  canvasEl.width = Math.round(w * dpr);
  canvasEl.height = Math.round(h * dpr);
  // Semua koordinat gambar memakai satuan CSS pixel
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clearCanvas() {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.restore();
}

// Video ditampilkan dengan object-fit: cover (memenuhi layar, sisi lebih
// dipotong). Posisi bounding box dari model harus dikonversi dengan rumus
// yang sama supaya kotak tetap pas di atas objek.
function mapVideoToCanvas(cw, ch) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  return {
    scale,
    offsetX: (cw - vw * scale) / 2,
    offsetY: (ch - vh * scale) / 2,
  };
}

// ==========================================
// MODEL AI (COCO-SSD)
// ==========================================

let model = null;
let modelStatus = "loading"; // "loading" | "ready" | "error"

function renderModelStatus() {
  const chip = $("model-chip");
  const chipText = $("model-chip-text");
  const chipSpinner = chip.querySelector(".spinner-sm");

  chip.hidden = modelStatus === "ready";
  chip.classList.toggle("error", modelStatus === "error");
  chipSpinner.hidden = modelStatus !== "loading";
  chipText.textContent =
    modelStatus === "error"
      ? "Model AI gagal dimuat. Periksa koneksi internet."
      : "Memuat model AI…";

  updateAIButton();
}

async function loadModel() {
  modelStatus = "loading";
  renderModelStatus();

  try {
    // Nama global dari library adalah "cocoSsd" (S besar)
    // Varian lain: 'mobilenet_v2' (lebih akurat) atau 'mobilenet_v1'
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });

    modelStatus = "ready";
    renderModelStatus();
    showToast("Model AI siap digunakan!");
    console.log("Model berhasil dimuat:", model);
  } catch (err) {
    console.error("Gagal memuat model:", err);
    modelStatus = "error";
    renderModelStatus();
  }
}

// ==========================================
// LOOP DETEKSI
// ==========================================
// Contoh hasil model.detect(video):
// [{ bbox: [x, y, width, height], class: "person", score: 0.95 }, ...]

let isAIDetecting = false;
let detectLoopRunning = false;
let lastSaveTime = 0;
const SAVE_INTERVAL_MS = 5000; // simpan ke DB maksimal sekali per 5 detik

async function saveDetectionsToDb(targets) {
  if (!db || targets.length === 0) return;

  const now = Date.now();
  if (now - lastSaveTime < SAVE_INTERVAL_MS) return;
  lastSaveTime = now;

  const payload = {
    timestamp: isMockMode
      ? new Date().toISOString()
      : firebase.firestore.FieldValue.serverTimestamp(),
    detections: targets.map((p) => ({
      class: p.class,
      confidence: parseFloat(p.score.toFixed(3)),
      bbox: p.bbox.map((v) => Math.round(v)),
    })),
    count: targets.length,
  };

  try {
    await db.collection("detections").add(payload);
    console.log(
      "Data tersimpan ke DB:",
      payload.detections.map((d) => d.class).join(", "),
    );
    showToast(
      `Tersimpan: ${payload.detections.map((d) => d.class).join(", ")}`,
    );
  } catch (err) {
    console.error("Gagal menyimpan ke DB:", err);
  }
}

function drawPredictions(predictions) {
  const cw = canvasEl.clientWidth;
  const ch = canvasEl.clientHeight;
  if (!cw || !ch || !videoEl.videoWidth) return;

  const { scale, offsetX, offsetY } = mapVideoToCanvas(cw, ch);

  ctx.clearRect(0, 0, cw, ch);

  predictions.forEach((pred) => {
    // Konversi koordinat video -> koordinat layar
    let x = pred.bbox[0] * scale + offsetX;
    const y = pred.bbox[1] * scale + offsetY;
    const w = pred.bbox[2] * scale;
    const h = pred.bbox[3] * scale;

    // Video kamera depan dicerminkan, kotak ikut dicerminkan (teks tetap normal)
    if (isFrontCamera) x = cw - x - w;

    const isTarget = TARGET_CLASSES.includes(pred.class);
    const confidence = pred.score;

    // Hijau untuk target, abu-abu untuk lainnya
    ctx.strokeStyle = isTarget ? "#10b981" : "#667280";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);

    if (isTarget && confidence > MIN_CONFIDENCE) {
      const label = `${pred.class} ${(confidence * 100).toFixed(0)}%`;

      ctx.font = '600 14px "Plus Jakarta Sans", sans-serif'; // set font DULU sebelum measureText
      const labelW = ctx.measureText(label).width + 12;
      const labelY = y < 28 ? y + 28 : y; // cegah label keluar dari atas layar
      const labelX = Math.min(Math.max(x, 0), cw - labelW); // cegah keluar dari sisi layar

      ctx.fillStyle = "#10b981";
      ctx.fillRect(labelX, labelY - 28, labelW, 28);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, labelX + 6, labelY - 9);
    }
  });
}

// Ambil hanya objek target dengan confidence cukup (bisa dipakai untuk simpan ke database)
function getTargetPredictions(predictions) {
  return predictions.filter(
    (p) => TARGET_CLASSES.includes(p.class) && p.score > MIN_CONFIDENCE,
  );
}

async function detectLoop() {
  // Cegah dua loop berjalan bersamaan (mis. saat ganti kamera)
  if (detectLoopRunning) return;
  detectLoopRunning = true;

  try {
    // Berhenti jika AI dimatikan, kamera mati, atau model belum siap
    while (isAIDetecting && isCameraOn && model) {
      if (videoEl.readyState >= 2) {
        const predictions = await model.detect(videoEl);

        // Status bisa berubah selama model menganalisis frame
        if (!isAIDetecting || !isCameraOn) break;

        drawPredictions(predictions);
        saveDetectionsToDb(getTargetPredictions(predictions));
      }

      // Tunggu frame berikutnya
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } catch (err) {
    console.error("Error pada loop deteksi:", err);
  } finally {
    detectLoopRunning = false;
    if (!isAIDetecting || !isCameraOn) clearCanvas();
  }
}

// ==========================================
// TOMBOL START / STOP AI
// ==========================================

function updateAIButton() {
  if (modelStatus === "loading") {
    btnAI.disabled = true;
    btnAI.textContent = "Memuat AI…";
    btnAI.className = "btn btn-success";
    return;
  }

  btnAI.disabled = false;

  if (modelStatus === "error") {
    btnAI.textContent = "Muat ulang model AI";
    btnAI.className = "btn btn-success";
    return;
  }

  btnAI.textContent = isAIDetecting ? "Stop AI" : "Start AI";
  btnAI.className = isAIDetecting ? "btn btn-danger" : "btn btn-success";
}

function setAI(on) {
  isAIDetecting = on;
  updateAIButton();

  if (on) {
    detectLoop();
  } else {
    clearCanvas();
  }
}

function setupAIButton() {
  btnAI.addEventListener("click", () => {
    if (modelStatus === "error") {
      loadModel();
      return;
    }
    if (modelStatus !== "ready") return;

    if (isAIDetecting) {
      setAI(false);
      return;
    }

    if (!isCameraOn) {
      showToast("Nyalakan kamera dulu.", "warn");
      return;
    }
    setAI(true);
  });
}

// ==========================================
// TAMPILAN TOMBOL KONTROL
// ==========================================

function updateControlsUI() {
  // Kamera
  btnCamera.classList.toggle("is-on", isCameraOn);
  btnCamera.setAttribute("aria-pressed", String(isCameraOn));
  $("label-camera").textContent = isCameraOn ? "Kamera aktif" : "Kamera mati";

  // Flash: redup jika kamera mati / tidak didukung (tetap bisa diketuk untuk lihat alasannya)
  btnFlash.classList.toggle("torch-on", torchOn);
  btnFlash.setAttribute("aria-pressed", String(torchOn));
  btnFlash.setAttribute("aria-disabled", String(!isCameraOn || !torchSupported));
  $("label-flash").textContent = torchOn ? "Flash menyala" : "Flash mati";

  // Switch: label menunjukkan kamera yang sedang dipakai
  $("label-switch").textContent =
    facingMode === "user" ? "Kamera depan" : "Kamera belakang";
}

function setupControls() {
  btnCamera.addEventListener("click", handleCameraToggle);
  btnFlash.addEventListener("click", handleFlashToggle);
  btnSwitch.addEventListener("click", handleSwitchCamera);

  updateControlsUI();
}

// ==========================================
// JALANKAN SAAT HALAMAN SIAP
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
  initDatabase();
  setupAIButton();
  setupControls();
  renderOverlay();
  renderModelStatus();

  // Canvas mengikuti ukuran layar (rotasi HP, resize jendela)
  if ("ResizeObserver" in window) {
    new ResizeObserver(resizeCanvas).observe($("camera-container"));
  } else {
    window.addEventListener("resize", resizeCanvas);
  }
  window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 200));

  // Kamera dan model dimuat bersamaan agar lebih cepat siap
  loadModel();
  startCamera();
});