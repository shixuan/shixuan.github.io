const API_BASE         = "/gallery";
const META_BASE        = "/gallery/meta";
const BATCH_SIZE       = 16;
const MAX_PER_VIEW     = 128;
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

function fetchMeta(key) {
  if (!metaCache[key]) {
    metaCache[key] = fetch(`${META_BASE}/${encodeURIComponent(key)}`)
      .then(r => r.json())
      .catch(() => {
        // 失败不缓存：中国网络场景下可能是短暂抖动，下次切到该图时重试
        delete metaCache[key];
        return { zh: "", en: "" };
      });
  }
  return metaCache[key];
}

function updateCaption(index) {
  const item = lgInstance?.galleryItems[index];
  if (!item?.key) return;

  fetchMeta(item.key).then(meta => {
    const html = [
      meta.zh ? `<p class="lg-cap-zh">${meta.zh}</p>` : "",
      meta.en ? `<p class="lg-cap-en">${meta.en}</p>` : "",
    ].join("");
    item.subHtml = html;
    // 只有当前仍在显示这张时才写 DOM，防止快速滑动时 caption 错位
    if (lgInstance?.index === index) {
      const sub = document.querySelector(".lg-sub-html");
      if (sub) sub.innerHTML = html;
    }
  });
}

// ── lightGallery v2 ───────────────────────────────────────────
let lgInstance = null;

function loadLightGalleryV2() {
  return new Promise((resolve, reject) => {
    if (window.lightGallery) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/lightgallery@2/lightgallery.umd.min.js";
    // 15s timeout：中国访问 jsDelivr 有时连通但不响应，onerror 不触发
    const timer = setTimeout(() => {
      s.onload = s.onerror = null;
      s.remove();
      reject(new Error("LG v2 CDN timeout"));
    }, 15000);
    s.onload  = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); reject(new Error("LG v2 CDN load error")); };
    document.head.appendChild(s);
  });
}

// 首次调用：初始化 LG 实例，绑事件和全部 anchor click
// 后续调用：增量 updateSlides，只绑新增 anchor click
function attachLightGallery(el, newAnchors) {
  const makeItems = anchors => anchors.map(a => ({
    src:     a.href,
    thumb:   a.querySelector("img")?.src || "",
    subHtml: a.dataset.subHtml || "",
    key:     a.dataset.key,   // 存 key 供 updateCaption 使用
  }));

  const bindClicks = (anchors, offset) => {
    anchors.forEach((a, i) => {
      a.addEventListener("click", e => {
        e.preventDefault();
        lgInstance.openGallery(offset + i);
      });
    });
  };

  if (!lgInstance) {
    lgInstance = window.lightGallery(el, {
      dynamic:   true,
      dynamicEl: makeItems(newAnchors),
      download:  false,
      counter:   true,
      preload:   3,
      speed:     300,
    });

    bindClicks(newAnchors, 0);

    // UI 显隐：点图片区域切换，click 覆盖桌面和移动端（移动端浏览器会合成 click）
    const onLgClick = e => {
      if (e.target.closest(".lg-img-wrap")) {
        document.querySelector(".lg-outer")?.classList.toggle("lg-ui-hidden");
      }
    };

    el.addEventListener("lgAfterOpen", () => {
      document.querySelector(".lg-outer")?.classList.remove("lg-ui-hidden");
      document.addEventListener("click", onLgClick);
    });

    el.addEventListener("lgBeforeClose", () => {
      document.removeEventListener("click", onLgClick);
    });

    el.addEventListener("lgAfterClose", () => {
      document.querySelector(".lg-outer")?.classList.remove("lg-ui-hidden");

      // 灯箱打开期间跳过的 JG 重排，在关闭后补做
      if (_pendingJgRefresh) {
        _pendingJgRefresh = false;
        const $jg = window.jQuery?.("#jg-gallery");
        if (!$jg) {
          console.warn("[gallery] jQuery not loaded, pending JG refresh skipped");
        } else {
          $jg.off("jg.complete").on("jg.complete", () => {
            if (!sectionFull() && !allLoaded()) observeSecondLastRow();
          });
          $jg.justifiedGallery("norewind");
        }
      } else if (!sectionFull() && !allLoaded()) {
        observeSecondLastRow();
      }
    });

    el.addEventListener("lgAfterSlide", e => {
      updateCaption(e.detail.index);
      if (lgInstance && e.detail.index >= lgInstance.galleryItems.length - 2) {
        loadMore();
      }
    });

  } else {
    const offset = lgInstance.galleryItems.length;
    // Append-only: push directly into galleryItems without calling updateSlides.
    // updateSlides replaces the whole array and re-renders current ± preload slides,
    // causing a visible flash on the slide the user is currently viewing.
    // LG is lazy — slides outside preload range have no DOM, so pushing new items
    // into the array is safe and has zero effect on already-rendered slides.
    makeItems(newAnchors).forEach(item => lgInstance.galleryItems.push(item));
    // Sync the counter total ("/ N" in the bottom-right)
    const counterAll = document.querySelector(".lg-counter-all");
    if (counterAll) counterAll.textContent = lgInstance.galleryItems.length;
    // Re-enable next button if user was on the old last slide
    document.querySelector(".lg-next")?.classList.remove("lg-next-disabled", "disabled");
    bindClicks(newAnchors, offset);
  }
}

function destroyLightGallery() {
  if (lgInstance) {
    try { lgInstance.destroy(); } catch (_) {}
    lgInstance = null;
  }
}

// ── justifiedGallery ─────────────────────────────────────────
function destroyJG() {
  const $ = window.jQuery;
  if (!$) return;
  try {
    const $jg = $("#jg-gallery");
    if ($jg.data("jg.instance")) $jg.justifiedGallery("destroy");
  } catch (_) {}
}

function destroyGalleryPlugins() {
  destroyLightGallery();
  destroyJG();
}

// ── Gallery items ─────────────────────────────────────────────
function createItems(items) {
  const frag = document.createDocumentFragment();
  items.forEach(obj => {
    const a   = document.createElement("a");
    a.href    = API_BASE + "/img/" + encodeURIComponent(obj.key);
    a.dataset.key = obj.key;
    const img = document.createElement("img");
    img.src   = API_BASE + "/thumb/" + encodeURIComponent(obj.key);
    img.alt   = "";
    img.style.opacity    = "0";
    img.style.transition = "opacity 0.4s ease";
    img.onload  = () => { img.style.opacity = "1"; };
    img.onerror = () => { img.style.opacity = "1"; };
    a.appendChild(img);
    frag.appendChild(a);
  });
  return frag;
}

function updateMeta() {
  const countEl = document.getElementById("img-count");
  if (countEl) countEl.textContent = totalImages + " photos";

  const updatedEl = document.getElementById("last-updated");
  if (updatedEl && firstImages?.length > 0 && firstImages[0].uploaded) {
    const d = new Date(firstImages[0].uploaded);
    updatedEl.textContent = "Updated " + d.toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric"
    });
  }
}

// ── Section / pagination ──────────────────────────────────────
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

function updateSectionNav() {
  const key = `${currentSection()}/${totalSections()}`;
  if (key === _lastNavKey) return;
  _lastNavKey = key;

  const wrap = document.getElementById("gallery-controls");
  wrap.innerHTML = "";

  if (totalSections() <= 1) return;

  const curSec   = currentSection();
  const sections = totalSections();

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

// ── Load ──────────────────────────────────────────────────────
let _aborter          = null;
let _observer         = null;
let _pendingJgRefresh = false;
let _lastNavKey       = "";

function setLoading(val) {
  loading = val;
  const el = document.getElementById("gallery-loading");
  if (el) el.style.display = val ? "" : "none";

  // 灯箱打开时在 toolbar 显示 indicator，消失时机由 removeLgIndicator 控制
  if (val) {
    const lgToolbar = document.querySelector(".lg-toolbar");
    if (lgToolbar && !lgToolbar.querySelector(".lg-load-indicator")) {
      const indicator = document.createElement("span");
      indicator.className = "lg-load-indicator";
      indicator.textContent = "Loading…";
      lgToolbar.appendChild(indicator);
    }
  }
}

function removeLgIndicator() {
  document.querySelector(".lg-load-indicator")?.remove();
}

function showRetry() {
  if (lgInstance?.lgOpened) {
    // 灯箱内：#gallery-loading 在 overlay 背后不可见，改写进 toolbar
    const lgToolbar = document.querySelector(".lg-toolbar");
    if (lgToolbar && !lgToolbar.querySelector(".lg-load-indicator")) {
      const span = document.createElement("span");
      span.className = "lg-load-indicator";
      span.style.cursor = "pointer";
      span.textContent = "Failed. Tap to retry";
      span.onclick = () => { span.remove(); loadMore(); };
      lgToolbar.appendChild(span);
    }
    return;
  }
  const el = document.getElementById("gallery-loading");
  if (!el) return;
  el.style.display = "";
  el.innerHTML = 'Failed to load. <a href="#" style="color:inherit;text-decoration:underline">Retry</a>';
  el.querySelector("a").onclick = e => {
    e.preventDefault();
    el.innerHTML = "Loading\u2026";
    // LG v2 未加载（CDN 失败场景）时，重新走完整初始化流程
    if (window.lightGallery) {
      loadMore();
    } else {
      initGallery();
    }
  };
}

async function loadMore() {
  if (loading || sectionFull() || allLoaded()) return;
  setLoading(true);

  const aborter = new AbortController();
  _aborter = aborter;
  // 15s timeout：中国访问 CF Worker 有时连通但不响应，需要超时兜底
  // 用独立 flag 区分"超时 abort"和"gotoSection 主动 abort"
  let _timedOut = false;
  const _timeoutId = setTimeout(() => {
    _timedOut = true;
    aborter.abort();
  }, 15000);

  try {
    const res = await fetch(`${API_BASE}/list?page=${nextApiPage}&limit=${BATCH_SIZE}`, { signal: aborter.signal });
    clearTimeout(_timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    apiTotalPages = data.totalPages;
    totalImages   = data.total;

    if (!firstImages) firstImages = data.images;
    updateMeta();

    const $ = window.jQuery;
    if (!$ || !$.fn.justifiedGallery) throw new Error("justifiedGallery not loaded");

    const grid = document.getElementById("jg-gallery");
    const $jg  = $(grid);

    // 追加 DOM，记录新增的 anchor 元素
    const frag       = createItems(data.images);
    const newAnchors = Array.from(frag.querySelectorAll("a"));
    grid.appendChild(frag);

    if (lgInstance?.lgOpened) {
      // 灯箱打开中：跳过 JG 重排，直接 updateSlides，避免 DOM 重排导致卡顿和闪黑屏
      // JG 重排推迟到 lgAfterClose 时执行
      attachLightGallery(grid, newAnchors);
      removeLgIndicator();
      _pendingJgRefresh = true;
    } else {
      const onJgComplete = function () {
        attachLightGallery(grid, newAnchors);
        removeLgIndicator();
        if (!sectionFull() && !allLoaded()) {
          if (document.documentElement.scrollHeight <= window.innerHeight) {
            loadMore();
          } else {
            observeSecondLastRow();
          }
        }
      };

      if (!jgInited) {
        $jg.justifiedGallery({
          rowHeight: 220,
          margins:   6,
          lastRow:   "nojustify",
          captions:  false
        }).on("jg.complete", onJgComplete);
        jgInited = true;
      } else {
        $jg.off("jg.complete").on("jg.complete", onJgComplete);
        $jg.justifiedGallery("norewind");
      }
    }

    nextApiPage++;
    batchesLoaded++;
  } catch (err) {
    clearTimeout(_timeoutId);
    // AbortError 分两种：gotoSection 主动取消（静默丢弃）vs. 超时（需 showRetry）
    if (err.name === "AbortError" && !_timedOut) {
      // gotoSection 主动取消，不做任何 UI 处理，finally 会跳过（_aborter 已被置 null）
    } else {
      removeLgIndicator();
      console.error("Failed to load gallery:", err);
      if (_aborter === aborter) {
        _aborter = null;
        setLoading(false);
        updateSectionNav();
        showRetry();
        return;
      }
    }
  } finally {
    if (_aborter === aborter) {
      _aborter = null;
      setLoading(false);
      updateSectionNav();
    }
  }
}

function gotoSection(sec) {
  const $ = window.jQuery;
  if (!$ || !$.fn.justifiedGallery) return;

  if (_aborter)  { _aborter.abort(); _aborter = null; }
  if (_observer) { _observer.disconnect(); _observer = null; }
  _pendingJgRefresh = false;
  setLoading(false);
  // showRetry() 会改写 innerHTML，翻页前重置，避免下一次 setLoading(true) 显示 retry 文字
  const _loadingEl = document.getElementById("gallery-loading");
  if (_loadingEl) _loadingEl.innerHTML = "Loading\u2026";

  const grid = document.getElementById("jg-gallery");
  destroyGalleryPlugins();
  grid.innerHTML = "";
  window.scrollTo({ top: 0, behavior: "smooth" });

  sectionStart  = (sec - 1) * BATCHES_PER_VIEW + 1;
  nextApiPage   = sectionStart;
  batchesLoaded = 0;
  jgInited      = false;
  _lastNavKey   = "";

  loadMore();
}

// ── Infinite scroll: observe second-to-last row ──────────────
function observeSecondLastRow() {
  if (_observer) { _observer.disconnect(); _observer = null; }
  if (sectionFull() || allLoaded()) return;

  const anchors = Array.from(document.querySelectorAll("#jg-gallery a"));
  if (anchors.length === 0) return;

  const rowTops = [...new Set(anchors.map(a => parseInt(a.style.top) || 0))].sort((a, b) => a - b);
  const targetTop = rowTops.length >= 2 ? rowTops[rowTops.length - 2] : rowTops[0];
  const target = anchors.find(a => (parseInt(a.style.top) || 0) === targetTop);
  if (!target) return;

  _observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) {
      _observer.disconnect();
      _observer = null;
      loadMore();
    }
  });
  _observer.observe(target);
}

// ── Init ──────────────────────────────────────────────────────
function initGallery() {
  loadLightGalleryV2()
    .then(() => loadMore())
    .catch(err => {
      console.error("Failed to load lightGallery v2:", err);
      showRetry();
    });
}

window.addEventListener("load", function () {
  const loadingEl = document.getElementById("gallery-loading");
  if (loadingEl) loadingEl.style.display = "";
  initGallery();
});
