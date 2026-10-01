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
  // (kode lama membandingkan apiKey dengan nilainya sendiri, sehingga
  //  kondisinya selalu false dan selalu jatuh ke Mock Mode)
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
        dbStatusEl.textContent = "FIREBASE ONLINE";
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
      dbStatusEl.textContent = "DEMO MODE";
      dbStatusEl.className = "status-badge demo";
    }
    console.log("Menggunakan Mock Database.");
  }
}

// ==========================================
// UI HELPER (sebelumnya dipanggil tapi belum didefinisikan)
// ==========================================

function showOverlay(title, desc = "") {
  const overlay = document.getElementById("overlay-msg");
  const text = document.getElementById("overlay-text");
  if (text) text.textContent = desc ? `${title} — ${desc}` : title;
  if (overlay) overlay.style.display = "flex";
}

function hideOverlay() {
  const overlay = document.getElementById("overlay-msg");
  if (overlay) overlay.style.display = "none";
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText =
    "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);" +
    "background:#10b981;color:#fff;padding:10px 18px;border-radius:8px;" +
    "font:14px sans-serif;z-index:9999;";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ==========================================
// KAMERA
// ==========================================

let isCameraOn = false;

async function startCamera() {
  const video = document.getElementById("video");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment", // kamera belakang di mobile
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        console.log(
          "Resolusi kamera:",
          video.videoWidth,
          "x",
          video.videoHeight,
        );
        resolve();
      };
    });

    await video.play();
    isCameraOn = true;

    // Samakan ukuran canvas dengan resolusi video
    const canvas = document.getElementById("canvas");
    if (canvas) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    hideOverlay();
    console.log("Kamera berhasil dinyalakan!");
  } catch (err) {
    console.error("Gagal akses kamera:", err);
    showOverlay(
      "Gagal mengakses kamera",
      "Pastikan izin kamera diberikan dan halaman dibuka lewat HTTPS/localhost.",
    );
  }
}

function stopCamera() {
  const video = document.getElementById("video");

  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  isCameraOn = false;
}

// ==========================================
// MODEL AI (COCO-SSD)
// ==========================================

let model = null;

async function loadModel() {
  showOverlay(
    "Memuat Model AI (COCO-SSD)...",
    "Mengunduh bobot model ± 5MB. Mohon tunggu.",
  );

  try {
    // Nama global dari library adalah "cocoSsd" (S besar)
    // Varian lain: 'mobilenet_v2' (lebih akurat) atau 'mobilenet_v1'
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });

    hideOverlay();
    showToast("Model AI siap digunakan!");
    console.log("Model berhasil dimuat:", model);
  } catch (err) {
    console.error("Gagal memuat model:", err);
    showOverlay(
      "Gagal Memuat Model AI",
      "Periksa koneksi internet Anda. Model perlu diunduh pertama kali.",
    );
  }
}

// ==========================================
// LOOP DETEKSI
// ==========================================
// Contoh hasil model.detect(video):
// [{ bbox: [x, y, width, height], class: "person", score: 0.95 }, ...]

let isAIDetecting = false;
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

async function detectLoop() {
  const video = document.getElementById("video");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  // Hentikan loop jika AI dimatikan, kamera mati, atau model belum siap
  if (!isAIDetecting || !isCameraOn || !model) return;

  const predictions = await model.detect(video);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  predictions.forEach((pred) => {
    const [x, y, w, h] = pred.bbox;
    const isTarget = TARGET_CLASSES.includes(pred.class);
    const confidence = pred.score;

    // Hijau untuk target, abu-abu untuk lainnya
    ctx.strokeStyle = isTarget ? "#10b981" : "#667280";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);

    if (isTarget && confidence > MIN_CONFIDENCE) {
      const label = `${pred.class} ${(confidence * 100).toFixed(0)}%`;

      ctx.font = "bold 14px sans-serif"; // set font DULU sebelum measureText
      const textWidth = ctx.measureText(label).width;
      const labelY = y < 25 ? y + 25 : y; // cegah label keluar dari canvas

      ctx.fillStyle = "#10b981";
      ctx.fillRect(x, labelY - 25, textWidth + 10, 25);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 5, labelY - 7);
    }
  });

  // Simpan ke database jika ada target terdeteksi
  const targets = getTargetPredictions(predictions);
  saveDetectionsToDb(targets);

  // Ulangi di frame berikutnya
  requestAnimationFrame(detectLoop);
}

// Ambil hanya objek target dengan confidence cukup (bisa dipakai untuk simpan ke database)
function getTargetPredictions(predictions) {
  return predictions.filter(
    (p) => TARGET_CLASSES.includes(p.class) && p.score > MIN_CONFIDENCE,
  );
}

// ==========================================
// TOMBOL START / STOP AI
// ==========================================

function setupAIButton() {
  const btnAI = document.getElementById("btn-ai"); // sesuaikan dengan id tombol di HTML-mu
  if (!btnAI) return;

  btnAI.addEventListener("click", () => {
    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d");

    if (!isAIDetecting) {
      if (!model) {
        showToast("Model AI belum siap.");
        return;
      }
      isAIDetecting = true;
      btnAI.textContent = "Stop AI";
      btnAI.className = "btn btn-danger";
      detectLoop();
    } else {
      isAIDetecting = false;
      btnAI.textContent = "Start AI";
      btnAI.className = "btn btn-success";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });
}

// ==========================================
// JALANKAN SAAT HALAMAN SIAP
// ==========================================

document.addEventListener("DOMContentLoaded", async () => {
  initDatabase();
  setupAIButton();
  await startCamera();
  await loadModel();
});
