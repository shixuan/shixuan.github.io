const THUMB_BASE = "/gallery/thumb";
const IMG_BASE   = "/gallery/img";
const UPLOAD_URL = "/gallery/admin/upload";
const DELETE_URL = "/gallery/admin/delete";
const META_URL   = "/gallery/admin/meta";
const META_BASE  = "/gallery/meta";
const LIST_URL   = "/gallery/list";

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll(".admin-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab, .admin-panel").forEach(el => el.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "manage" && document.getElementById("photo-grid").children.length === 0) {
      loadPhotos(true);
    }
  });
});

// ── Upload ────────────────────────────────────────────────────
const MAX_THUMB_WIDTH = 400;
const THUMB_QUALITY   = 0.6;

function uploadLog(msg) {
  const el = document.getElementById("upload-log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

async function createThumb(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > MAX_THUMB_WIDTH) { h = Math.round(h * MAX_THUMB_WIDTH / w); w = MAX_THUMB_WIDTH; }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("toBlob returned null")),
        "image/jpeg", THUMB_QUALITY
      );
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(file);
  });
}

document.getElementById("uploadBtn").addEventListener("click", async () => {
  const files = document.getElementById("fileInput").files;
  if (!files || !files.length) { alert("Please choose files first."); return; }

  for (const file of files) {
    uploadLog("Processing " + file.name + " ...");
    let thumb;
    try {
      thumb = await createThumb(file);
      uploadLog("  Thumbnail: " + thumb.size + " bytes");
    } catch (e) {
      uploadLog("  ⚠ Thumbnail failed, using original: " + e.message);
      thumb = file;
    }

    const form = new FormData();
    form.append("original", file, file.name);
    form.append("thumb", thumb, file.name + ".thumb.jpg");

    try {
      const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
      if (!res.ok) { uploadLog("  ✗ Failed: " + res.status); continue; }
      const data = await res.json();
      uploadLog("  ✓ Uploaded: " + data.key);
    } catch (e) {
      uploadLog("  ✗ Error: " + e.message);
    }
  }
  uploadLog("Done.");
});

// ── Manage ────────────────────────────────────────────────────
let currentPage = 1;
let totalPages  = 1;
let selected    = new Set();

function setStatus(msg) {
  document.getElementById("manage-status").textContent = msg;
}

function updateSelUI() {
  const btn = document.getElementById("deleteSelectedBtn");
  btn.style.display = selected.size > 0 ? "inline-block" : "none";
  document.getElementById("sel-count").textContent = selected.size;
}

async function loadPhotos(reset) {
  if (reset) {
    document.getElementById("photo-grid").innerHTML = "";
    currentPage = 1;
    selected.clear();
    updateSelUI();
  }

  setStatus("Loading…");
  try {
    const res  = await fetch(`${LIST_URL}?page=${currentPage}&limit=48`);
    const data = await res.json();

    totalPages = data.totalPages;
    appendCards(data.images);
    currentPage++;

    const hasMore = currentPage <= totalPages;
    document.getElementById("loadMoreBtn").style.display = hasMore ? "block" : "none";
    setStatus(document.getElementById("photo-grid").children.length + " / " + data.total + " photos");
  } catch (e) {
    setStatus("Error: " + e.message);
  }
}

function appendCards(images) {
  const grid = document.getElementById("photo-grid");
  for (const img of images) {
    const card = document.createElement("div");
    card.className = "photo-card";
    card.dataset.key = img.key;

    const date = img.uploaded ? new Date(img.uploaded).toLocaleDateString() : "";
    card.innerHTML = `
      <img src="${THUMB_BASE}/${encodeURIComponent(img.key)}" loading="lazy" alt=""
           onerror="this.style.opacity=.25" />
      <input type="checkbox" class="card-check" />
      <div class="card-info">${date}</div>
      <button class="card-edit" title="Edit caption">✎</button>
      <button class="card-del" title="Delete">✕</button>
    `;

    card.querySelector("img").addEventListener("click", () => openLightbox(img.key));
    card.querySelector(".card-check").addEventListener("change", e => {
      if (e.target.checked) { selected.add(img.key); card.classList.add("selected"); }
      else { selected.delete(img.key); card.classList.remove("selected"); }
      updateSelUI();
    });
    card.querySelector(".card-edit").addEventListener("click", e => {
      e.stopPropagation();
      openCaptionModal(img.key);
    });
    card.querySelector(".card-del").addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm("Delete this photo?")) return;
      const ok = await deletePhoto(img.key);
      if (ok) {
        card.remove();
        setStatus(document.getElementById("photo-grid").children.length + " photos loaded");
      }
    });

    grid.appendChild(card);
  }
}

async function deletePhoto(key) {
  try {
    const res = await fetch(`${DELETE_URL}?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    return res.ok;
  } catch (e) {
    alert("Delete failed: " + e.message);
    return false;
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => loadPhotos(true));
document.getElementById("loadMoreBtn").addEventListener("click", () => loadPhotos(false));

document.getElementById("deleteSelectedBtn").addEventListener("click", async () => {
  if (!confirm(`Delete ${selected.size} photos?`)) return;
  const keys = [...selected];
  const results = await Promise.all(keys.map(deletePhoto));
  keys.forEach((key, i) => {
    if (results[i]) document.querySelector(`.photo-card[data-key="${CSS.escape(key)}"]`)?.remove();
  });
  selected.clear();
  updateSelUI();
  setStatus(document.getElementById("photo-grid").children.length + " photos loaded");
});

// ── Lightbox ──────────────────────────────────────────────────
// img 动态创建，避免 Icarus 全局 LG 在页面初始化时把它扫进去
function openLightbox(key) {
  const lb = document.getElementById("lightbox");
  lb.innerHTML = "";
  const img = document.createElement("img");
  img.src = `${IMG_BASE}/${encodeURIComponent(key)}`;
  img.alt = "";
  lb.appendChild(img);
  lb.classList.add("open");
}
document.getElementById("lightbox").addEventListener("click", () => {
  const lb = document.getElementById("lightbox");
  lb.classList.remove("open");
  lb.innerHTML = "";
});

// ── Caption modal ─────────────────────────────────────────────
let captionCurrentKey = null;

function openCaptionModal(key) {
  captionCurrentKey = key;
  document.getElementById("caption-key-display").textContent = key;
  document.getElementById("caption-zh").value = "";
  document.getElementById("caption-en").value = "";
  document.getElementById("caption-modal").classList.add("open");

  // Lazily fetch existing caption
  fetch(`${META_BASE}/${encodeURIComponent(key)}`)
    .then(r => r.json())
    .then(data => {
      document.getElementById("caption-zh").value = data.zh || "";
      document.getElementById("caption-en").value = data.en || "";
    })
    .catch(() => {});
}

document.getElementById("caption-cancel-btn").addEventListener("click", () => {
  document.getElementById("caption-modal").classList.remove("open");
  captionCurrentKey = null;
});

document.getElementById("caption-translate-btn").addEventListener("click", async () => {
  const zh = document.getElementById("caption-zh").value.trim();
  if (!zh || !captionCurrentKey) return;

  const btn = document.getElementById("caption-translate-btn");
  btn.textContent = "Translating…";
  btn.disabled = true;

  try {
    const res = await fetch(META_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: captionCurrentKey, zh, en: "" })
    });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    document.getElementById("caption-en").value = data.en || "";
  } catch (e) {
    alert("Translation failed: " + e.message);
  } finally {
    btn.textContent = "Auto-translate";
    btn.disabled = false;
  }
});

document.getElementById("caption-save-btn").addEventListener("click", async () => {
  if (!captionCurrentKey) return;
  const zh  = document.getElementById("caption-zh").value.trim();
  const en  = document.getElementById("caption-en").value.trim();
  const btn = document.getElementById("caption-save-btn");
  btn.textContent = "Saving…";
  btn.disabled = true;

  try {
    const res = await fetch(META_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: captionCurrentKey, zh, en })
    });
    if (!res.ok) throw new Error(res.status);
    document.getElementById("caption-modal").classList.remove("open");
    captionCurrentKey = null;
  } catch (e) {
    alert("Save failed: " + e.message);
  } finally {
    btn.textContent = "Save";
    btn.disabled = false;
  }
});
