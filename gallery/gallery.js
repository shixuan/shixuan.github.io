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
// LRU 上限：避免长时间浏览（1000+ 图）后 metaCache 无界增长
const META_CACHE_MAX = 500;
const metaCache = new Map();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fetchMeta(key) {
  if (metaCache.has(key)) {
    // 触摸：移到 Map 末尾，标记为最近使用
    const v = metaCache.get(key);
    metaCache.delete(key);
    metaCache.set(key, v);
    return v;
  }
  const p = fetch(`${META_BASE}/${encodeURIComponent(key)}`)
    .then(r => r.json())
    .catch(() => {
      // 失败不缓存：中国网络场景下可能是短暂抖动，下次切到该图时重试
      metaCache.delete(key);
      return { zh: "", en: "" };
    });
  cachePut(key, p);
  return p;
}

function cachePut(key, promise) {
  metaCache.set(key, promise);
  if (metaCache.size > META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== key) metaCache.delete(oldest);
  }
}

// 批量预取：loadMore 拿到 data.images 后立即调用，把这一批的 meta 一次性拉回
// 灌进 cache。后续 fetchMeta 命中缓存，灯箱翻图零 RTT。
// 失败 / 缺路由（Worker 还没部署）静默回退，fetchMeta 按单条懒加载工作。
async function prefetchMetas(keys) {
  const missing = keys.filter(k => !metaCache.has(k));
  if (missing.length === 0) return;

  try {
    const url = `${API_BASE}/metas?keys=${missing.map(encodeURIComponent).join(",")}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const map = await res.json();

    for (const key of missing) {
      // 期间 fetchMeta 已经填了 cache 就别覆盖（避免抹掉用户正在 await 的 promise）
      if (metaCache.has(key)) continue;
      cachePut(key, Promise.resolve(map[key] || { zh: "", en: "" }));
    }
    // 把新拿到的 meta 灌进 LG item 的 subHtml —— 关键一步，否则 cache
    // 只省 RTT 不省渲染 flash
    applySubHtml(lgInstance?.galleryItems);
  } catch {
    // 静默：单条懒加载仍可工作
  }
}

function renderCaption(meta) {
  return [
    meta.zh ? `<p class="lg-cap-zh">${escapeHtml(meta.zh)}</p>` : "",
    meta.en ? `<p class="lg-cap-en">${escapeHtml(meta.en)}</p>` : "",
  ].join("");
}

// 把已经在 cache 里的 meta 灌进对应 LG item 的 subHtml。
// 关键：LG 切到 slide 时直接读 item.subHtml 渲染，这一步如果赶在
// 切之前完成就没有"空一下再有"的 flash。
// 同时如果灌到的就是当前显示的 slide，主动写一次 DOM —— LG 不会
// 主动重读已显示 slide 的 subHtml
function applySubHtml(items) {
  if (!items) return;
  for (const item of items) {
    if (!item.key || item.subHtml) continue;
    if (!metaCache.has(item.key)) continue;
    metaCache.get(item.key).then(meta => {
      const html = renderCaption(meta);
      item.subHtml = html;
      const curIdx = lgInstance?.index;
      if (curIdx != null && lgInstance.galleryItems[curIdx] === item) {
        const sub = document.querySelector(".lg-sub-html");
        if (sub) sub.innerHTML = html;
      }
    });
  }
}

function updateCaption(index) {
  const item = lgInstance?.galleryItems[index];
  if (!item?.key) return;
  // 已经被 applySubHtml 提前灌过，LG 已经把它渲染出来了 —— 跳过
  if (item.subHtml) return;

  fetchMeta(item.key).then(meta => {
    const html = renderCaption(meta);
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
let _lgListenersBound = false;

// UI 显隐：点图片区域切换。模块级单例 —— add/remove 用同一引用，
// 且整页只绑一次 lgAfterOpen/Close，避免翻 section 后监听叠加把 toggle 抵消掉
const onLgClick = e => {
  if (e.target.closest(".lg-img-wrap")) {
    document.querySelector(".lg-outer")?.classList.toggle("lg-ui-hidden");
  }
};

// 在指定 slide 的 .lg-img-wrap 里插入 blur backdrop（如果还没有的话）。
// backdrop 用缩略图作背景 + CSS blur —— 用户从 grid 点进来时这张缩略图
// 已经在浏览器 cache 里，所以 backdrop 立刻可见，掩盖了拉原图的网络延迟。
// idempotent：多次调用同一 index 不会重复插入。
function ensureBlurBackdrop(index) {
  if (!lgInstance) return;
  const item = lgInstance.galleryItems[index];
  if (!item?.thumb) return;
  // LG slide DOM id 约定：lg-item-<lgId>-<index>（从 LG 源码 getSlideItemId 得知）
  const slide = document.getElementById(`lg-item-${lgInstance.lgId}-${index}`);
  if (!slide) return;
  const wrap = slide.querySelector(".lg-img-wrap");
  if (!wrap) return;
  if (wrap.querySelector(":scope > .lg-blur-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "lg-blur-backdrop";
  backdrop.style.backgroundImage = `url("${item.thumb}")`;
  // 必须插在 <img> 前面：position:absolute z-index:0 + img 默认 position:relative
  // → img 自然栈在 backdrop 之上
  wrap.insertBefore(backdrop, wrap.firstChild);
}

// el 上的四个 LG 事件监听整页只绑一次。handler 内 lazy 引用 lgInstance，
// 所以 destroy + 重建实例后这套监听依旧对新实例生效，无需重绑
function bindLgElListeners(el) {
  if (_lgListenersBound) return;
  _lgListenersBound = true;

  el.addEventListener("lgAfterOpen", () => {
    document.querySelector(".lg-outer")?.classList.remove("lg-ui-hidden");
    document.addEventListener("click", onLgClick);
    // 灯箱刚打开的第一张
    if (lgInstance) ensureBlurBackdrop(lgInstance.index);
  });

  // slide DOM 一被 LG append 进来就装 backdrop —— 比等 lgBeforeSlide 更早，
  // 给浏览器更多时间解码缩略图。同时再用 new Image 强制把缩略图灌进 image
  // cache —— 应对低端机内存压力下被 evict 的角落情况。
  el.addEventListener("lgAfterAppendSlide", e => {
    const idx = e.detail.index;
    ensureBlurBackdrop(idx);
    const item = lgInstance?.galleryItems[idx];
    if (item?.thumb) {
      const probe = new Image();
      probe.src = item.thumb;   // GC 自动回收，不挂 DOM
    }
  });

  // 兜底：用户跳转到某个 slide 时如果 backdrop 还没装（极端情况下
  // lgAfterAppendSlide 没赶上），这里补一次
  el.addEventListener("lgBeforeSlide", e => ensureBlurBackdrop(e.detail.index));

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
}

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

// LG CDN 加载与首批列表请求并行：原先 initGallery 先等 LG 才发列表请求，
// 浪费一整轮 RTT。现在并行 — LG 没就绪期间用户点缩略图会走 <a href> 原生跳转
// （在新标签打开原图），LG 就绪后 attachLightGallery 才覆盖 click 行为。
let _lgReady = null;

// 首次调用：初始化 LG 实例，绑事件和全部 anchor click
// 后续调用：增量 updateSlides，只绑新增 anchor click
async function attachLightGallery(el, newAnchors) {
  if (_lgReady) {
    try { await _lgReady; }
    catch (e) {
      console.warn("attachLightGallery: LG unavailable, falling back to native links", e);
      return;
    }
  }

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
      // LG 默认 allowMediaOverlap=false → 它会按 .lg-sub-html 的实际高度
      // 把图片区域 top/bottom 缩短留出位置。原来 caption 长期是空、高度小
      // 所以没明显缩；现在 prefetch 让 caption 真填上内容，缩量立刻变可见。
      // 改成 true：让 caption overlay 在图片底部，图片占满灯箱，自带渐变背景
      allowMediaOverlap: true,
    });

    bindClicks(newAnchors, 0);
    bindLgElListeners(el);

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

  // Prefetch 可能比 LG 早就绪（LG CDN 慢时常见）。那时 applySubHtml 调用
  // 时 lgInstance 还不存在 → 没生效。这里 LG 刚就绪，回头把 cache 里
  // 已经有的 meta 全部灌进新 items 的 subHtml
  applySubHtml(lgInstance.galleryItems);
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
    const v   = obj.version ? `?v=${encodeURIComponent(obj.version)}` : "";
    const a   = document.createElement("a");
    a.href    = API_BASE + "/img/" + encodeURIComponent(obj.key) + v;
    a.dataset.key = obj.key;
    const img = document.createElement("img");
    img.src   = API_BASE + "/thumb/" + encodeURIComponent(obj.key) + v;
    img.alt   = "";
    // 不加 loading="lazy"：justifiedGallery 要拿 naturalWidth/Height 算行高，
    // 浏览器级 lazy 会让屏外图不下载、JG 算出 0×0 → 布局错乱
    img.style.opacity    = "0";
    img.style.transition = "opacity 0.4s ease";
    img.onload  = () => { img.style.opacity = "1"; };
    // 坏图（key 已删但仍被引用等）：隐藏整个 anchor，否则 0×0 会把 JG 行高算歪。
    // 不从 DOM/galleryItems 移除，避免 LG slide 索引错位
    img.onerror = () => { a.style.display = "none"; };
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

    // 防御：API 偶发返回非数字时，避免后续 NaN 比较把分页判断挂掉
    apiTotalPages = Number.isFinite(data.totalPages) ? data.totalPages : 1;
    totalImages   = Number.isFinite(data.total) ? data.total : 0;

    // 空批次：停在这里，免得 IntersectionObserver 把同一页空响应反复打回来
    if (!Array.isArray(data.images) || data.images.length === 0) {
      apiTotalPages = Math.min(apiTotalPages, nextApiPage - 1);
      if (!firstImages) firstImages = [];
      updateMeta();
      return;
    }

    if (!firstImages) firstImages = data.images;
    updateMeta();

    // 后台预取这一批 meta，灯箱里翻图就不用每张一次 RTT。
    // 不 await —— 缩略图渲染流程不需要等它
    prefetchMetas(data.images.map(i => i.key));

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

  // 过滤掉 onerror 隐藏的坏图 anchor —— display:none 元素 IntersectionObserver
  // 不会触发 isIntersecting，整行都是坏图时触底加载会卡死
  const anchors = Array.from(document.querySelectorAll("#jg-gallery a"))
    .filter(a => a.style.display !== "none");
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
  // LG CDN 加载与列表请求并行 —— attachLightGallery 内部 await _lgReady
  // 才会绑 click，所以两者顺序不影响功能
  _lgReady = loadLightGalleryV2();
  _lgReady.catch(err => {
    // LG 挂了不视为致命：图还能正常展示，只是点开是原生跳转
    console.warn("lightGallery v2 failed to load:", err);
  });
  loadMore();
}

// DOMContentLoaded 即可，不必等 window.load —— gallery 页面正文无重资源
function _bootGallery() {
  const loadingEl = document.getElementById("gallery-loading");
  if (loadingEl) loadingEl.style.display = "";
  initGallery();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _bootGallery);
} else {
  _bootGallery();
}
