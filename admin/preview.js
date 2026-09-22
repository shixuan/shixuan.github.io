/* global CMS, createClass, h, markdownit, texmath */
(() => {
  let loading;
  let queue = Promise.resolve();

  function loadMathJax() {
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        window.MathJax = {
          startup: { typeset: false },
          svg: { fontCache: 'none' },
          loader: { load: ['ui/safe'] },
        };
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js';
        script.onload = () => window.MathJax.startup.promise.then(resolve, reject);
        script.onerror = () => reject(new Error('MathJax could not load. Reload the editor to retry.'));
        document.head.appendChild(script);
      });
    }
    return loading;
  }

  const plain = markdownit({ html: false, linkify: true });
  const math = markdownit({ html: false, linkify: true }).use(texmath, {
    delimiters: ['dollars', 'brackets'],
    engine: {
      // Protect TeX before Markdown can interpret underscores or backslashes.
      renderToString(tex, options) {
        return `<span data-tex-display="${options.displayMode}">${plain.utils.escapeHtml(tex)}</span>`;
      },
    },
  });

  const Preview = createClass({
    componentDidMount() {
      this.active = true;
      this.schedule();
    },
    componentDidUpdate() {
      this.schedule();
    },
    componentWillUnmount() {
      this.active = false;
      this.revision++;
      clearTimeout(this.timer);
    },
    schedule() {
      const revision = this.revision = (this.revision || 0) + 1;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.updatePreview(revision), 200);
    },
    updatePreview(revision) {
      const entry = this.props.entry;
      const enabled = entry.getIn(['data', 'mathjax']) !== false;
      const body = entry.getIn(['data', 'body']) || '';
      const target = this.content;
      const current = () => this.active && this.revision === revision;
      const fragment = target.ownerDocument.createElement('div');
      // Raw HTML is escaped, rather than executed in the authenticated editor.
      fragment.innerHTML = (enabled ? math : plain).render(body);
      target.replaceChildren(fragment.cloneNode(true));
      this.notice.textContent = '';
      if (!enabled || !fragment.querySelector('[data-tex-display]')) return;

      // Serialize conversions; stale renders never overwrite more recent edits.
      queue = queue.then(async () => {
        if (!current()) return;
        await loadMathJax();
        if (!current()) return;
        const mj = window.MathJax;
        // SVG output also includes assistive MathML. Its stylesheet must live
        // in the preview iframe, otherwise both representations are visible.
        const previewDocument = target.ownerDocument;
        if (!previewDocument.getElementById('MJX-SVG-styles')) {
          const sheet = mj.startup.document.documentStyleSheet();
          previewDocument.head.appendChild(previewDocument.importNode(sheet, true));
        }
        mj.texReset();
        for (const node of fragment.querySelectorAll('[data-tex-display]')) {
          if (!current()) return;
          const result = await mj.tex2svgPromise(node.textContent, {
            display: node.dataset.texDisplay === 'true',
            em: 16,
            ex: 8,
            containerWidth: target.clientWidth || 600,
          });
          node.replaceWith(result);
        }
        if (current()) target.replaceChildren(fragment);
      }).catch(() => {
        if (current()) this.notice.textContent = 'Math preview unavailable. Reload the editor to retry.';
      });
    },
    render() {
      return h('article', { className: 'post-preview' },
        h('h1', {}, this.props.entry.getIn(['data', 'title'])),
        h('p', { role: 'status', ref: node => { this.notice = node; } }),
        // React owns the container; the preview renderer owns its children.
        h('div', { ref: node => { this.content = node; } }),
      );
    },
  });

  CMS.registerPreviewStyle(`
    .post-preview { padding: 20px; font: 16px/1.7 system-ui, sans-serif; overflow-wrap: anywhere; }
    .post-preview img { max-width: 100%; }
    .post-preview pre { overflow: auto; padding: 12px; background: #f4f4f4; }
    .post-preview table { border-collapse: collapse; }
    .post-preview th, .post-preview td { border: 1px solid #ddd; padding: 6px 10px; }
    .post-preview [role=status]:empty { display: none; }
    .post-preview [role=status] { color: #a33; }
    .post-preview mjx-container { display: inline-block; line-height: 0; text-indent: 0; }
    .post-preview mjx-container[display="true"] { display: block; text-align: center; overflow-x: auto; padding: 1em 0; }
    .post-preview mjx-container svg { max-width: none; overflow: visible; }
  `, { raw: true });
  CMS.registerPreviewTemplate('posts', Preview);
})();
