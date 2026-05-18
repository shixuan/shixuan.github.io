const THUMB_BASE = "/gallery/thumb";
const IMG_BASE   = "/gallery/img";
const UPLOAD_URL   = "/gallery/admin/upload";
const DELETE_URL   = "/gallery/admin/delete";
const REPLACE_URL  = "/gallery/admin/replace";
const META_URL     = "/gallery/admin/meta";
const META_BASE  = "/gallery/meta";
const LIST_URL   = "/gallery/list";

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
  // Refresh the grid below so freshly uploaded photos show up
  loadPhotos(true);
});

// ── Manage ────────────────────────────────────────────────────
let currentPage = 1;
let totalPages  = 1;
let selected    = new Set();
let mgLoading   = false;

function setStatus(msg) {
  document.getElementById("manage-status").textContent = msg;
}

function updateSelUI() {
  const btn = document.getElementById("deleteSelectedBtn");
  btn.style.display = selected.size > 0 ? "inline-block" : "none";
  document.getElementById("sel-count").textContent = selected.size;
}

async function loadPhotos(reset) {
  // 并发守卫：上传完自动刷新 + 用户点 Refresh / 连点，会让多次重载交错，
  // 响应乱序回来导致卡片重复或丢失、currentPage 错位
  if (mgLoading) return;
  mgLoading = true;

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
  } finally {
    mgLoading = false;
  }
}

function appendCards(images) {
  const grid = document.getElementById("photo-grid");
  for (const img of images) {
    const card = document.createElement("div");
    card.className = "photo-card";
    card.dataset.key = img.key;
    if (img.version) card.dataset.version = img.version;

    const v    = img.version ? `?v=${encodeURIComponent(img.version)}` : "";
    const date = img.uploaded ? new Date(img.uploaded).toLocaleDateString() : "";
    card.innerHTML = `
      <img src="${THUMB_BASE}/${encodeURIComponent(img.key)}${v}" loading="lazy" alt=""
           onerror="this.style.opacity=.25" />
      <input type="checkbox" class="card-check" />
      <input type="file" class="card-replace-input" accept="image/*" style="display:none" />
      <div class="card-info">${date}</div>
      <button class="card-replace" title="Replace image">↻</button>
      <button class="card-edit" title="Edit caption">✎</button>
      <button class="card-del" title="Delete">✕</button>
    `;

    card.querySelector("img").addEventListener("click", () => openLightbox(img.key, img.version));
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

    card.querySelector(".card-replace").addEventListener("click", e => {
      e.stopPropagation();
      card.querySelector(".card-replace-input").click();
    });
    card.querySelector(".card-replace-input").addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!confirm(`Replace this photo with "${file.name}"?\nMetadata (date, caption, filename) will be kept.`)) {
        e.target.value = "";
        return;
      }
      const btn = card.querySelector(".card-replace");
      btn.textContent = "…";
      btn.disabled = true;
      try {
        await replacePhoto(img.key, file, card);
      } finally {
        btn.textContent = "↻";
        btn.disabled = false;
        e.target.value = "";
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

async function replacePhoto(key, file, card) {
  let thumb;
  try {
    thumb = await createThumb(file);
  } catch (e) {
    thumb = file;
  }

  const form = new FormData();
  form.append("key", key);
  form.append("original", file, file.name);
  form.append("thumb", thumb, file.name + ".thumb.jpg");

  try {
    const res = await fetch(REPLACE_URL, { method: "POST", body: form });
    if (!res.ok) { alert("Replace failed: " + res.status); return; }
    // Force-reload the thumbnail by busting cache
    const cardImg = card.querySelector("img");
    cardImg.src = `${THUMB_BASE}/${encodeURIComponent(key)}?t=${Date.now()}`;
    cardImg.style.opacity = "";
    setStatus("Replaced: " + key);
  } catch (e) {
    alert("Replace failed: " + e.message);
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => loadPhotos(true));
document.getElementById("loadMoreBtn").addEventListener("click", () => loadPhotos(false));

document.getElementById("deleteSelectedBtn").addEventListener("click", async () => {
  if (!confirm(`Delete ${selected.size} photos?`)) return;
  const keys = [...selected];

  // 限并发：大批量选中时别一次性甩 N 个 DELETE 把 Worker 打满
  const CONCURRENCY = 5;
  const results = new Array(keys.length);
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const slice = keys.slice(i, i + CONCURRENCY);
    const r = await Promise.all(slice.map(deletePhoto));
    r.forEach((ok, j) => { results[i + j] = ok; });
  }

  keys.forEach((key, i) => {
    if (results[i]) document.querySelector(`.photo-card[data-key="${CSS.escape(key)}"]`)?.remove();
  });
  selected.clear();
  updateSelUI();
  setStatus(document.getElementById("photo-grid").children.length + " photos loaded");
});

// ── Lightbox ──────────────────────────────────────────────────
// img 动态创建，避免 Icarus 全局 LG 在页面初始化时把它扫进去
function openLightbox(key, version) {
  const lb = document.getElementById("lightbox");
  lb.innerHTML = "";
  const img = document.createElement("img");
  const v   = version ? `?v=${encodeURIComponent(version)}` : "";
  img.src = `${IMG_BASE}/${encodeURIComponent(key)}${v}`;
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

// ── Init ──────────────────────────────────────────────────────
// 放文件末尾：保证调用时所有模块级 let 已初始化（避免 defer 场景下的 TDZ）。
// 脚本若被 defer/async 或挪位置，DOMContentLoaded 可能已触发 —— 这种情况直接跑
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => loadPhotos(true));
} else {
  loadPhotos(true);
}
