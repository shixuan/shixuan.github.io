(() => {
  // Icarus calls loadInsight at DOMContentLoaded. Keep its UI and search engine.
  const loadInsight = window.loadInsight;
  if (loadInsight) {
    window.loadInsight = (...args) => {
      let started = false;
      function open() {
        if (!started) {
          started = true;
          loadInsight(...args);
        }
        document.querySelector(".searchbox")?.classList.add("show");
        document.querySelector(".searchbox-input")?.focus();
      }
      function activate(event) {
        if (event.target.closest(".navbar-main .search")) open();
      }
      document.addEventListener("click", activate, true);
      document.addEventListener("focusin", activate, true);
      window.addEventListener("hashchange", () => {
        if (location.hash === "#insight-search") open();
      });
      if (location.hash === "#insight-search") open();
    };
  }

  document
    .querySelectorAll("template[data-lazy-comment]")
    .forEach((template) => {
      const container = template.parentElement;
      let started = false;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button is-small";
      retry.textContent = "Comments could not load. Retry";
      retry.addEventListener("click", load);
      function load() {
        if (started) return;
        started = true;
        retry.remove();
        const script = document.createElement("script");
        for (const attribute of template.content.querySelector("script")
          .attributes) {
          script.setAttribute(attribute.name, attribute.value);
        }
        script.onerror = () => {
          script.remove();
          started = false;
          container.append(retry);
        };
        template.after(script);
      }
      if (!("IntersectionObserver" in window)) {
        load();
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            load();
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(container);
    });
})();
