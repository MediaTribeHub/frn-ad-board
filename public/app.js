(() => {
  "use strict";

  const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
  const PREVIEW_TIMEOUT_MS = 8000;
  const DEFAULT_TZ = "America/New_York";

  const $ = id => document.getElementById(id);
  const els = {
    updated: $("updated"),
    title: $("title"),
    subtitle: $("subtitle"),
    stale: $("stale"),
    filters: $("filters"),
    buckets: $("buckets"),
    status: $("status"),
    search: $("search"),
    count: $("count"),
    grid: $("grid"),
    message: $("message"),
    modal: $("modal"),
    modalTitle: $("modal-title"),
    modalStatus: $("modal-status"),
    modalClose: $("modal-close"),
    modalFrame: $("modal-frame"),
    modalExpired: $("modal-expired"),
    modalLink: $("modal-link")
  };

  const state = { data: null, bucket: "all", status: "all", query: "" };
  const modalState = { opener: null, scrollY: 0, timer: null };

  // ---------- tiny DOM helper (never uses innerHTML with data) ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------- dates, always in the board's time zone ----------

  const tz = () => (state.data && state.data.timezone) || DEFAULT_TZ;

  function ymd(date, timeZone) {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  function daysBetween(a, b, timeZone) {
    return Math.round((Date.parse(ymd(b, timeZone)) - Date.parse(ymd(a, timeZone))) / 86400000);
  }

  function tzAbbrev(date, timeZone) {
    for (const style of ["shortGeneric", "short"]) {
      try {
        const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style })
          .formatToParts(date).find(p => p.type === "timeZoneName");
        if (part) return part.value.replace(/^E[SD]T$/, "ET").replace(/^C[SD]T$/, "CT").replace(/^M[SD]T$/, "MT").replace(/^P[SD]T$/, "PT");
      } catch (_) { /* older browsers: try the next style */ }
    }
    return "";
  }

  function formatUpdated(date, timeZone) {
    const now = new Date();
    const diff = daysBetween(date, now, timeZone);
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
    const day = diff === 0 ? "today" : diff === 1 ? "yesterday" : shortDate(date, timeZone);
    return `Last updated · ${day} at ${time} ${tzAbbrev(date, timeZone)}`.trim();
  }

  function shortDate(date, timeZone) {
    const sameYear = ymd(date, timeZone).slice(0, 4) === ymd(new Date(), timeZone).slice(0, 4);
    const opts = { timeZone, month: "short", day: "numeric" };
    if (!sameYear) opts.year = "numeric";
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  }

  function sinceLabel(date, timeZone) {
    const diff = daysBetween(date, new Date(), timeZone);
    if (diff < 7) return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);
    return shortDate(date, timeZone);
  }

  // ---------- loading ----------

  function renderSkeletons() {
    els.grid.replaceChildren(...Array.from({ length: 6 }, () =>
      h("div", { class: "card card--skeleton", "aria-hidden": "true" },
        h("div", { class: "thumb" }),
        h("div", { class: "card__body" },
          h("div", { class: "skeleton skeleton--title" }),
          h("div", { class: "skeleton skeleton--line" })
        ),
        h("div", { class: "card__footer" }, h("div", { class: "skeleton skeleton--button" }))
      )
    ));
  }

  function showLoadError() {
    els.grid.replaceChildren();
    els.grid.setAttribute("aria-busy", "false");
    els.filters.hidden = true;
    els.message.replaceChildren(h("p", null, "We couldn't load the board right now. Try again in a few minutes."));
    els.message.hidden = false;
  }

  async function load() {
    renderSkeletons();
    let data;
    try {
      const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
      if (!data || !Array.isArray(data.ads)) throw new Error("bad shape");
    } catch (_) {
      showLoadError();
      return;
    }
    state.data = normalize(data);
    renderChrome();
    renderBuckets();
    render();
  }

  function normalize(data) {
    const ads = data.ads
      .filter(a => a && a.id)
      .map(a => ({
        ...a,
        name: String(a.name || "Untitled ad"),
        label: String(a.title || a.name || "Untitled ad"),
        status: a.status === "live" ? "live" : "paused",
        buckets: Array.isArray(a.buckets) ? a.buckets : [],
        copies: Number(a.copies) || 1,
        launchedMs: Date.parse(a.launchedAt) || 0
      }))
      .sort((a, b) =>
        (a.status === b.status ? 0 : a.status === "live" ? -1 : 1) || b.launchedMs - a.launchedMs
      );
    return { ...data, ads, buckets: Array.isArray(data.buckets) ? data.buckets : [] };
  }

  // ---------- header, timestamp, stale bar ----------

  function renderChrome() {
    const { data } = state;
    if (data.title) {
      els.title.textContent = data.title;
      document.title = data.title;
    }
    if (data.subtitle) els.subtitle.textContent = data.subtitle;

    const updated = new Date(data.lastUpdated);
    if (isNaN(updated)) {
      els.updated.textContent = " ";
      return;
    }
    els.updated.textContent = formatUpdated(updated, tz());

    if (Date.now() - updated.getTime() > STALE_AFTER_MS) {
      els.stale.textContent = `Heads up — this board hasn't refreshed since ${sinceLabel(updated, tz())}. We're on it.`;
      els.stale.hidden = false;
    }
  }

  // ---------- filters ----------

  function renderBuckets() {
    const { ads, buckets } = state.data;
    const pills = [pillButton("all", "All", null)];
    for (const b of buckets) {
      const n = ads.filter(a => a.buckets.includes(b)).length;
      if (n > 0) pills.push(pillButton(b, b, n));
    }
    els.buckets.replaceChildren(...pills);
  }

  function pillButton(value, label, n) {
    return h("button", {
      type: "button",
      class: "pill-button",
      "data-bucket": value,
      "aria-pressed": String(state.bucket === value)
    }, label, n != null ? h("span", { class: "n" }, ` · ${n}`) : null);
  }

  function syncPressed(container, attr, value) {
    for (const btn of container.querySelectorAll(`[${attr}]`)) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute(attr) === value));
    }
  }

  function matches(ad) {
    if (state.bucket !== "all" && !ad.buckets.includes(state.bucket)) return false;
    if (state.status !== "all" && ad.status !== state.status) return false;
    if (state.query) {
      const q = state.query;
      const hay = `${ad.name} ${ad.label} ${ad.details || ""}${ad.batch ? ` batch ${ad.batch} b${ad.batch}` : ""}`.toLowerCase();
      if (!q.split(/\s+/).every(word => hay.includes(word))) return false;
    }
    return true;
  }

  function clearFilters() {
    state.bucket = "all";
    state.status = "all";
    state.query = "";
    els.search.value = "";
    syncPressed(els.buckets, "data-bucket", "all");
    syncPressed(els.status, "data-status", "all");
    render();
  }

  // ---------- grid ----------

  function render() {
    const all = state.data.ads;
    const shown = all.filter(matches);

    els.count.textContent = `Showing ${shown.length} of ${all.length} ${all.length === 1 ? "ad" : "ads"}`;
    els.grid.setAttribute("aria-busy", "false");
    els.grid.replaceChildren(...shown.map(card));

    if (shown.length === 0) {
      const filtered = state.bucket !== "all" || state.status !== "all" || state.query;
      els.message.replaceChildren(
        h("p", null, filtered ? "No ads match those filters." : "No ads to show yet."),
        filtered ? h("button", { type: "button", onclick: clearFilters }, "Clear filters") : null
      );
      els.message.hidden = false;
    } else {
      els.message.hidden = true;
    }
  }

  function statusPill(status, extraClass) {
    const live = status === "live";
    return h("span", { class: `pill ${live ? "pill--live" : ""} ${extraClass || ""}`.trim() }, live ? "Live" : "Paused");
  }

  function thumbFallback(ad) {
    return h("div", { class: "thumb__fallback", "aria-hidden": "true" }, ad.batch ? `Batch ${ad.batch}` : "");
  }

  function card(ad) {
    const hasPreview = Boolean(ad.previewUrl);

    let media;
    if (ad.thumbnailUrl) {
      media = h("img", { src: ad.thumbnailUrl, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
      media.addEventListener("error", () => media.replaceWith(thumbFallback(ad)), { once: true });
    } else {
      media = thumbFallback(ad);
    }

    const chips = [];
    if (ad.buckets[0]) chips.push(h("span", { class: "chip" }, ad.buckets[0]));
    if (ad.buckets.length > 1) {
      chips.push(h("span", { class: "chip", title: ad.buckets.slice(1).join(", ") }, `+${ad.buckets.length - 1}`));
    }
    const bv = [ad.batch ? `Batch ${ad.batch}` : null, ad.version ? `V${ad.version}` : null].filter(Boolean).join(" · ");
    if (bv) chips.push(h("span", { class: "chip" }, bv));
    if (ad.launchedMs) chips.push(h("span", { class: "chip" }, `Launched ${shortDate(new Date(ad.launchedMs), tz())}`));

    const button = h("button", {
      type: "button",
      class: "preview-button",
      disabled: !hasPreview,
      "aria-label": hasPreview ? `View ad preview: ${ad.label}` : null
    }, hasPreview ? "View ad preview" : "Preview unavailable");
    if (hasPreview) button.addEventListener("click", () => openPreview(ad, button));

    return h("article", { class: `card${hasPreview ? " is-clickable" : ""}` },
      h("div", { class: "thumb" }, media, statusPill(ad.status)),
      h("div", { class: "card__body" },
        h("h3", { class: "card__name", title: ad.name }, ad.label),
        ad.details ? h("p", { class: "card__details" }, ad.details) : null,
        chips.length ? h("div", { class: "chips" }, chips) : null,
        ad.copies > 1 ? h("p", { class: "copies" }, `${ad.copies} versions running across ad sets`) : null
      ),
      h("div", { class: "card__footer" }, button)
    );
  }

  // ---------- preview modal ----------

  function openPreview(ad, opener) {
    modalState.opener = opener;
    modalState.scrollY = window.scrollY;

    els.modalTitle.textContent = ad.label;
    const pill = statusPill(ad.status);
    pill.id = "modal-status";
    els.modalStatus.replaceWith(pill);
    els.modalStatus = pill;
    els.modalLink.href = ad.previewUrl;
    els.modalExpired.hidden = true;

    // The iframe is created only now, never in the grid.
    const frame = h("iframe", {
      src: ad.previewUrl,
      title: `Ad preview: ${ad.label}`,
      allow: "autoplay; encrypted-media; picture-in-picture",
      allowfullscreen: true
    });
    frame.addEventListener("load", () => clearTimeout(modalState.timer), { once: true });
    els.modalFrame.replaceChildren(frame);
    els.modalFrame.hidden = false;

    clearTimeout(modalState.timer);
    modalState.timer = setTimeout(() => {
      els.modalFrame.hidden = true;
      els.modalFrame.replaceChildren();
      els.modalExpired.hidden = false;
    }, PREVIEW_TIMEOUT_MS);

    document.documentElement.style.overflow = "hidden";
    els.modal.showModal();
    els.modalClose.focus();
  }

  function onModalClosed() {
    clearTimeout(modalState.timer);
    els.modalFrame.replaceChildren(); // stops any playing video
    document.documentElement.style.overflow = "";
    window.scrollTo(0, modalState.scrollY);
    if (modalState.opener && document.contains(modalState.opener)) {
      modalState.opener.focus({ preventScroll: true });
    }
    modalState.opener = null;
  }

  // ---------- wiring ----------

  els.buckets.addEventListener("click", e => {
    const btn = e.target.closest("[data-bucket]");
    if (!btn) return;
    state.bucket = btn.dataset.bucket;
    syncPressed(els.buckets, "data-bucket", state.bucket);
    render();
  });

  els.status.addEventListener("click", e => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    state.status = btn.dataset.status;
    syncPressed(els.status, "data-status", state.status);
    render();
  });

  let searchTimer = null;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim().toLowerCase();
      if (state.data) render();
    }, 150);
  });

  els.modalClose.addEventListener("click", () => els.modal.close());
  els.modal.addEventListener("click", e => { if (e.target === els.modal) els.modal.close(); });
  els.modal.addEventListener("close", onModalClosed);

  // Hairline under the sticky filter bar once it's actually stuck.
  if ("IntersectionObserver" in window) {
    const sentinel = h("div", { "aria-hidden": "true" });
    els.filters.before(sentinel);
    new IntersectionObserver(([entry]) => {
      els.filters.classList.toggle("is-stuck", !entry.isIntersecting);
    }).observe(sentinel);
  }

  load();
})();
