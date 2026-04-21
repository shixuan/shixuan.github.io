/* ================================================================
   arcade-shelf boot glue for the Icarus Game Card widget.

   The server-rendered widget (widgets/game-card.jsx) only emits a
   mount point: <div class="arcade-shelf-mount" data-title="..."
   data-whitelist="..." data-order="..." data-preview-count="...">
   and optionally a sibling <button class="game-card-more-btn">.
   This script finds each mount, spins up an arcade-shelf instance
   pre-registered with the built-in games, and — when preview_count
   is set — wires the More button to an overlay listing all games.

   Single-modal UX: clicking a game in the More overlay closes the
   overlay first, then opens arcade-shelf's game modal via the
   public openGameModal() export — no modal stacking.

   Load order: arcade-shelf UMD is injected first with `defer`, so
   window.ArcadeShelf is guaranteed to exist when this file runs.
   ================================================================ */
(function () {
  "use strict";

  function readJsonData(el, key) {
    const raw = el.dataset[key];
    if (!raw) return undefined;
    try { return JSON.parse(raw); }
    catch (e) {
      console.warn("arcade-shelf-init: invalid data-" + key, raw);
      return undefined;
    }
  }

  // Register every built-in game that this arcade-shelf version ships.
  // Filter(Boolean) so older versions without snake keep working — when the
  // blog bumps to arcade-shelf 0.2+, AS.snake becomes truthy and joins in
  // automatically, no edit needed here.
  function collectGames(AS) {
    return [AS.pong, AS.minesweeper, AS.snake].filter(Boolean);
  }

  // Apply arcade-shelf's own sort semantics so preview_count picks the
  // same "first N" the library would render if no whitelist were set.
  function sortByOrder(games) {
    return games.slice().sort(function (a, b) {
      const ao = typeof a.order === "number" ? a.order : Number.POSITIVE_INFINITY;
      const bo = typeof b.order === "number" ? b.order : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });
  }

  function openMoreOverlay(AS, games, onCloseFocusTarget) {
    const overlay = document.createElement("div");
    overlay.className = "game-card-more-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "All games");

    const panel = document.createElement("div");
    panel.className = "game-card-more-panel";

    const header = document.createElement("div");
    header.className = "game-card-more-header";
    const heading = document.createElement("span");
    heading.className = "game-card-more-title";
    heading.textContent = "All games";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "game-card-more-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "\u00d7";
    header.appendChild(heading);
    header.appendChild(closeBtn);

    const list = document.createElement("ul");
    list.className = "game-card-more-list";
    list.setAttribute("role", "list");

    games.forEach(function (game) {
      const li = document.createElement("li");
      li.className = "game-card-more-item";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "game-card-more-game-btn";
      btn.dataset.gameName = game.name;
      if (game.description) btn.title = game.description;
      btn.setAttribute("aria-label", game.description ? game.name + " — " + game.description : game.name);

      if (game.icon) {
        const ic = document.createElement("span");
        ic.className = "game-card-more-icon";
        ic.textContent = game.icon;
        ic.setAttribute("aria-hidden", "true");
        btn.appendChild(ic);
      }

      const label = document.createElement("span");
      label.className = "game-card-more-label";
      label.textContent = game.name;
      btn.appendChild(label);

      if (game.description) {
        const desc = document.createElement("span");
        desc.className = "game-card-more-desc";
        desc.textContent = game.description;
        btn.appendChild(desc);
      }

      li.appendChild(btn);
      list.appendChild(li);
    });

    panel.appendChild(header);
    panel.appendChild(list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      overlay.removeEventListener("click", onBackdrop);
      closeBtn.removeEventListener("click", close);
      list.removeEventListener("click", onListClick);
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      document.body.style.overflow = prevBodyOverflow;
    }

    function onBackdrop(e) {
      if (e.target === overlay) close();
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    function onListClick(e) {
      const btn = e.target && e.target.closest && e.target.closest(".game-card-more-game-btn");
      if (!btn) return;
      const name = btn.dataset.gameName;
      const game = games.find(function (g) { return g.name === name; });
      if (!game) return;
      // Single-modal UX: tear down overlay BEFORE arcade-shelf opens its own
      // modal, so there's never a stack. openGameModal handles the rest
      // (focus trap, Esc, canvas lifecycle) — we just launch and let go.
      close();
      try {
        AS.openGameModal(game, btn);
      } catch (err) {
        console.error("arcade-shelf-init: openGameModal failed", err);
        if (onCloseFocusTarget && typeof onCloseFocusTarget.focus === "function") {
          onCloseFocusTarget.focus();
        }
      }
    }

    overlay.addEventListener("click", onBackdrop);
    closeBtn.addEventListener("click", close);
    list.addEventListener("click", onListClick);
    document.addEventListener("keydown", onKey);

    closeBtn.focus();
    return { close: close };
  }

  function mountAll() {
    const AS = window.ArcadeShelf;
    if (!AS || typeof AS.createShelf !== "function") {
      console.warn("arcade-shelf-init: window.ArcadeShelf not available");
      return;
    }

    const allGames = collectGames(AS);
    const sorted = sortByOrder(allGames);

    document.querySelectorAll(".arcade-shelf-mount").forEach(function (mount) {
      if (mount.dataset.arcadeShelfMounted === "1") return;
      mount.dataset.arcadeShelfMounted = "1";

      const title = mount.dataset.title || "Let's play!";
      const whitelist = readJsonData(mount, "whitelist");
      const order = readJsonData(mount, "order");
      const previewCountRaw = parseInt(mount.dataset.previewCount, 10);
      const previewCount = Number.isFinite(previewCountRaw) && previewCountRaw > 0
        ? previewCountRaw
        : null;

      // preview_count takes the top N from the globally-sorted list and uses
      // those names as the primary shelf's whitelist. The remaining games
      // live in the More overlay's list.
      let effectiveWhitelist = whitelist;
      if (previewCount !== null && previewCount < sorted.length) {
        effectiveWhitelist = sorted.slice(0, previewCount).map(function (g) { return g.name; });
      }

      const shelf = AS.createShelf({
        container: mount,
        title: title,
        whitelist: effectiveWhitelist,
        order: order
      });
      allGames.forEach(function (g) { shelf.register(g); });
      shelf.mount();

      // Wire the More button only if preview_count is set AND there are
      // games beyond the preview. No games hidden → no point showing it.
      if (previewCount !== null && sorted.length > previewCount) {
        const card = mount.closest(".game-card");
        const moreBtn = card && card.querySelector(".game-card-more-btn");
        // Relocate the button into arcade-shelf's own header so it sits to the
        // right of the "Let's play!" title. The header is rendered by
        // shelf.mount() above and is already display:flex, so a margin-left:auto
        // on the button is all CSS needs.
        const shelfHeader = mount.querySelector(".arcade-shelf-card-header");
        if (moreBtn && shelfHeader) {
          shelfHeader.appendChild(moreBtn);
          moreBtn.hidden = false;
          moreBtn.addEventListener("click", function () {
            openMoreOverlay(AS, sorted, moreBtn);
          });
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})();
