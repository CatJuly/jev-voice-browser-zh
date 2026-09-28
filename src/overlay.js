/**
 * Lightweight feedback overlay injected into every controlled page (context.addInitScript).
 * Exposes window.__vb = { highlight, toast, candidates, clearCandidates }.
 * Self-contained: runs in the page, no closures over Node scope.
 */
export function installOverlay() {
  if (window.__vb) return;
  const Z = 2147483000;
  const css = `
    .__vb-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#f9fafb;
      font:600 15px/1.3 -apple-system,Segoe UI,Inter,sans-serif;padding:10px 16px;border-radius:10px;
      box-shadow:0 8px 30px rgba(0,0,0,.35);z-index:${Z};opacity:0;transition:opacity .15s;pointer-events:none;max-width:70vw}
    .__vb-toast.__vb-show{opacity:1}
    .__vb-hl{position:absolute;border:3px solid #f59e0b;border-radius:6px;box-shadow:0 0 0 4px rgba(245,158,11,.25),0 0 24px rgba(245,158,11,.6);
      z-index:${Z};pointer-events:none;transition:opacity .3s}
    .__vb-badge{position:absolute;background:#2563eb;color:#fff;font:700 14px/1 -apple-system,Segoe UI,Inter,sans-serif;
      padding:5px 8px;border-radius:999px;z-index:${Z};pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4);
      border:2px solid #fff}
    .__vb-cand{position:absolute;border:2px dashed #2563eb;border-radius:6px;z-index:${Z};pointer-events:none;
      background:rgba(37,99,235,.08)}
  `;
  const ensureStyle = () => {
    if (document.getElementById("__vb-style")) return;
    const s = document.createElement("style");
    s.id = "__vb-style";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  const byId = (id) => document.querySelector(`[data-vb-id="${id}"]`);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height };
  };

  let toastEl = null;
  let toastTimer = null;
  const api = {
    toast(msg, ms = 1800) {
      ensureStyle();
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement("div");
        toastEl.className = "__vb-toast";
        document.documentElement.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      requestAnimationFrame(() => toastEl.classList.add("__vb-show"));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("__vb-show"), ms);
    },
    highlight(id, ms = 600) {
      ensureStyle();
      const el = byId(id);
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const b = box(el);
      const h = document.createElement("div");
      h.className = "__vb-hl";
      Object.assign(h.style, { top: b.top - 4 + "px", left: b.left - 4 + "px", width: b.width + 8 + "px", height: b.height + 8 + "px" });
      document.documentElement.appendChild(h);
      setTimeout(() => (h.style.opacity = "0"), ms);
      setTimeout(() => h.remove(), ms + 350);
      return true;
    },
    candidates(list, ms = 8000) {
      ensureStyle();
      api.clearCandidates();
      let first = true;
      for (const c of list) {
        const el = byId(c.id);
        if (!el) continue;
        if (first) {
          el.scrollIntoView({ block: "center" });
          first = false;
        }
        const b = box(el);
        const frame = document.createElement("div");
        frame.className = "__vb-cand __vb-c";
        Object.assign(frame.style, { top: b.top - 3 + "px", left: b.left - 3 + "px", width: b.width + 6 + "px", height: b.height + 6 + "px" });
        const badge = document.createElement("div");
        badge.className = "__vb-badge __vb-c";
        badge.textContent = String(c.n);
        Object.assign(badge.style, { top: Math.max(0, b.top - 14) + "px", left: Math.max(0, b.left - 14) + "px" });
        document.documentElement.appendChild(frame);
        document.documentElement.appendChild(badge);
      }
      api._candTimer = setTimeout(api.clearCandidates, ms);
    },
    clearCandidates() {
      clearTimeout(api._candTimer);
      document.querySelectorAll(".__vb-c").forEach((n) => n.remove());
    },
  };
  window.__vb = api;
}
