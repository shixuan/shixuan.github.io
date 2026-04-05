const API_BASE         = "/gallery";
const META_BASE        = "/gallery/meta";
const BATCH_SIZE       = 24;
const MAX_PER_VIEW     = 120;
const BATCHES_PER_VIEW = MAX_PER_VIEW / BATCH_SIZE;

let nextApiPage   = 1;
let sectionStart  = 1;
let apiTotalPages = 1;
let totalImages   = 0;
let batchesLoaded = 0;
let loading       = false;
let jgInited      = false;
let firstImages   = null;

// ── Meta / Caption ────────────────────────────────────────────
const metaCache = {};

async function fetchMeta(key) {
  if (metaCache[key] !== undefined) return metaCache[key];
  metaCache[key] = { zh: "", en: "" };
  try {
    const res  = await fetch(`${META_BASE}/${encodeURIComponent(key)}`);
    const data = await res.json();
    metaCache[key] = data;
  } catch {
    delete metaCache[key];
  }
  return metaCache[key];
}

function updateCaption(index, anchors) {
  const key    = anchors[index]?.dataset.key;
  const anchor = anchors[index];
  if (!key) return;
  fetchMeta(key).then(meta => {
    const hasCaption = meta.zh || meta.en;
    const html = hasCaption
      ? [meta.zh ? `<p class="lg-cap-zh">${meta.zh}</p>` : "",
         meta.en ? `<p class="lg-cap-en">${meta.en}</p>` : ""].join("")
      : "";

    // Cache on the anchor so LG uses it natively on future opens/slides
    if (anchor) anchor.dataset.subHtml = html;

    const sub = document.querySelector(".lg-sub-html");
    if (sub) sub.innerHTML = html;
  });
}

// ── lightGallery ──────────────────────────────────────────────
function destroyLightGallery() {
  const $ = window.jQuery;
  if (!$) return;
  try {
    const lg = $("#jg-gallery").data("lightGallery");
    if (lg && typeof lg.destroy === "function") lg.destroy(true);
  } catch (_) {}
}

function destroyGalleryPlugins() {
  destroyLightGallery();
  const $ = window.jQuery;
  if (!$) return;
  try {
    const $jg = $("#jg-gallery");
    if ($jg.data("jg.instance")) $jg.justifiedGallery("destroy");
  } catch (_) {}
}

function attachLightGallery(el) {
  const $ = window.jQuery;
  const anchors = Array.from(el.querySelectorAll("a"));

  $(el).lightGallery({ selector: "a", download: false });

  $(el).off("onAfterOpen.lg").on("onAfterOpen.lg", function() {
    $(".lg-outer").removeClass("lg-ui-hidden");
    // setTimeout(0) 确保在 LG 完成自身渲染后再写入 caption
    // 不是任意延迟，而是"当前同步执行结束后"的语义
    setTimeout(() => {
      const lg = $(el).data("lightGallery");
      if (lg) updateCaption(lg.index, anchors);
    }, 0);
    // 点击/tap 图片切换 UI 显隐（toolbar / arrows / caption）
    // 手机端 LG 会 preventDefault touch 事件导致 click 不触发，需同时监听 touchend
    // 用 touchstart 记录起点，touchend 时判断位移，超过阈值视为滑动则忽略
    let _tox = 0, _toy = 0;
    $(document)
      .off("click.lgToggle touchstart.lgToggle touchend.lgToggle")
      .on("touchstart.lgToggle", ".lg-object", function(e) {
        const t = e.originalEvent.touches[0];
        _tox = t.clientX; _toy = t.clientY;
      })
      .on("touchend.lgToggle", ".lg-object", function(e) {
        const t = e.originalEvent.changedTouches[0];
        if (Math.abs(t.clientX - _tox) < 10 && Math.abs(t.clientY - _toy) < 10) {
          $(".lg-outer").toggleClass("lg-ui-hidden");
        }
      })
      .on("click.lgToggle", ".lg-object", function() {
        $(".lg-outer").toggleClass("lg-ui-hidden");
      });
  });

  $(el).off("onBeforeClose.lg").on("onBeforeClose.lg", function() {
    $(document).off("click.lgToggle touchstart.lgToggle touchend.lgToggle");
  });

  $(el).off("onAfterSlide.lg").on("onAfterSlide.lg", function(e, prevIndex, index) {
    updateCaption(index, anchors);
  });
}

// ── Gallery items ─────────────────────────────────────────────
function createItems(items) {
  const frag = document.createDocumentFragment();
  items.forEach(obj => {
    const a   = document.createElement("a");
    a.href    = API_BASE + "/img/" + encodeURIComponent(obj.key);
    a.dataset.key = obj.key;
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src   = API_BASE + "/thumb/" + encodeURIComponent(obj.key);
    img.alt   = "";
    a.appendChild(img);
    frag.appendChild(a);
  });
  return frag;
}

function updateMeta() {
  const countEl = document.getElementById("img-count");
  if (countEl) countEl.textContent = totalImages + " photos";

  const updatedEl = document.getElementById("last-updated");
  if (updatedEl && firstImages && firstImages.length > 0 && firstImages[0].uploaded) {
    const d = new Date(firstImages[0].uploaded);
    updatedEl.textContent = "Updated " + d.toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric"
    });
  }
}

// ── Pagination / section logic ────────────────────────────────
function totalSections() {
  return Math.max(1, Math.ceil(apiTotalPages / BATCHES_PER_VIEW));
}
function currentSection() {
  return Math.ceil(sectionStart / BATCHES_PER_VIEW);
}
function sectionFull() {
  return batchesLoaded >= BATCHES_PER_VIEW;
}
function allLoaded() {
  return nextApiPage > apiTotalPages;
}

function updateControls() {
  const wrap = document.getElementById("gallery-controls");
  wrap.innerHTML = "";

  const canLoadMore = !sectionFull() && !allLoaded();
  const sections    = totalSections();
  const curSec      = currentSection();

  if (canLoadMore) {
    const btn = document.createElement("button");
    const remaining = totalImages - (sectionStart - 1) * BATCH_SIZE - batchesLoaded * BATCH_SIZE;
    const inSection = Math.min(remaining, (BATCHES_PER_VIEW - batchesLoaded) * BATCH_SIZE);
    btn.textContent = `Load More (${inSection > 0 ? inSection : remaining} remaining)`;
    btn.onclick = loadMore;
    wrap.appendChild(btn);
  }

  if (sections > 1) {
    const nav = document.createElement("div");
    nav.className = "gallery-section-nav";

    const prev = document.createElement("button");
    prev.textContent = "\u00AB Prev";
    prev.disabled = curSec <= 1;
    prev.onclick = () => gotoSection(curSec - 1);
    nav.appendChild(prev);

    const info = document.createElement("span");
    info.className = "section-info";
    info.textContent = curSec + " / " + sections;
    nav.appendChild(info);

    const next = document.createElement("button");
    next.textContent = "Next \u00BB";
    next.disabled = curSec >= sections;
    next.onclick = () => gotoSection(curSec + 1);
    nav.appendChild(next);

    wrap.appendChild(nav);
  }
}

async function loadMore() {
  if (loading || sectionFull() || allLoaded()) return;
  loading = true;

  try {
    const res  = await fetch(`${API_BASE}/list?page=${nextApiPage}&limit=${BATCH_SIZE}`);
    const data = await res.json();

    apiTotalPages = data.totalPages;
    totalImages   = data.total;

    if (!firstImages) firstImages = data.images;
    updateMeta();

    const $ = window.jQuery;
    if (!$ || !$.fn.justifiedGallery) return;

    const grid = document.getElementById("jg-gallery");
    const $jg  = $(grid);

    destroyLightGallery();          // 只销毁 LG，保留 justifiedGallery 实例
    grid.appendChild(createItems(data.images));

    if (!jgInited) {
      $jg.justifiedGallery({
        rowHeight: 220,
        margins:   6,
        lastRow:   "nojustify",
        captions:  false
      }).on("jg.complete", function () {
        attachLightGallery(grid);
      });
      jgInited = true;
    } else {
      $jg.off("jg.complete").on("jg.complete", function () {
        attachLightGallery(grid);
      });
      $jg.justifiedGallery("norewind");
    }

    nextApiPage++;
    batchesLoaded++;
  } catch (err) {
    console.error("Failed to load gallery:", err);
  } finally {
    loading = false;
    updateControls();
  }
}

async function gotoSection(sec) {
  const $ = window.jQuery;
  if (!$ || !$.fn.justifiedGallery) return;

  const grid = document.getElementById("jg-gallery");

  destroyGalleryPlugins();
  grid.innerHTML = "";

  sectionStart  = (sec - 1) * BATCHES_PER_VIEW + 1;
  nextApiPage   = sectionStart;
  batchesLoaded = 0;
  jgInited      = false;

  await loadMore();
}

window.addEventListener("load", function () {
  loadMore();
});
