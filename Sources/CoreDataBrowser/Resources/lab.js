"use strict";

// =======================================================================
// CoreDataBrowser — Lab view
//
// Module layout (built up across passes):
//   - CDBGrid    (pass 2): data grid + records toolbar
//   - CDBDetail  (pass 3): detail / relationships / content viewer  [todo]
//   - bootstrap  (pass 4): state, API, splitters, localStorage, history  [todo]
// =======================================================================


/* =======================================================================
   CDBGrid — table grid + records toolbar
   View + interaction only. No fetches, no localStorage, no history.
   ======================================================================= */

const CDBGrid = (function () {

  // ---- Inline SVG icons ------------------------------------------------
  const ICON_SEARCH =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L13.5 13.5"/></svg>';
  const ICON_SORT =
    '<svg viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M4 0 L8 6 L0 6 Z"/></svg>';
  const ICON_CHEVRON_DOWN =
    '<svg viewBox="0 0 8 5" fill="currentColor" aria-hidden="true"><path d="M0 0 L4 5 L8 0 Z"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5 L5 9.5 L10 3"/></svg>';

  // ---- Tiny helpers ----------------------------------------------------
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function formatBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  const NUMERIC_TYPES = new Set(["Int16", "Int32", "Int64", "Float", "Double", "Decimal"]);
  function typeClass(type) {
    if (NUMERIC_TYPES.has(type)) return "col-numeric";
    if (type === "Date") return "col-date";
    if (type === "Bool") return "col-bool";
    return "";
  }

  function defaultWidth(type) {
    if (NUMERIC_TYPES.has(type)) return 92;
    if (type === "Date") return 180;
    if (type === "Bool") return 70;
    if (type === "UUID" || type === "URI" || type === "ObjectID") return 280;
    if (type === "Binary" || type === "Transformable") return 130;
    return 220; // default for String + unknown
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  // Reconcile `prefs.order` with the schema so newly-added attrs still appear,
  // removed attrs disappear, and `prefs.hidden` is respected.
  function visibleAttrs(entity, prefs) {
    const schemaOrder = entity.attributes.map((a) => a.name);
    const baseOrder = (prefs && prefs.order ? prefs.order : schemaOrder).filter((n) =>
      schemaOrder.includes(n)
    );
    for (const n of schemaOrder) {
      if (!baseOrder.includes(n)) baseOrder.push(n);
    }
    const hidden = new Set((prefs && prefs.hidden) || []);
    return baseOrder.filter((n) => !hidden.has(n));
  }

  function renderCell(value, attr) {
    if (value === null || value === undefined) {
      return { html: "null", cls: "val-null", title: "null" };
    }
    if (typeof value === "object") {
      if (value.type === "binary") {
        return {
          html: "binary&nbsp;·&nbsp;" + escapeHTML(formatBytes(value.bytes)),
          cls: "val-binary",
          title: value.bytes + " bytes",
        };
      }
      if (value.type === "transformable") {
        return { html: "transformable", cls: "val-binary", title: "transformable" };
      }
      const s = JSON.stringify(value);
      return { html: escapeHTML(s), cls: "val-binary", title: s };
    }
    if (typeof value === "boolean") {
      return {
        html: value ? "true" : "false",
        cls: value ? "val-true" : "val-false",
        title: String(value),
      };
    }
    const s = String(value);
    return { html: escapeHTML(s), cls: "", title: s };
  }


  // ---- Popover management ---------------------------------------------
  // Only one popover is open at a time. Outside-click + Escape dismiss it.
  let activePopover = null;
  function closeActivePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
      document.removeEventListener("mousedown", popoverOutsideClick, true);
      document.removeEventListener("keydown", popoverEsc, true);
    }
  }
  function popoverOutsideClick(ev) {
    if (activePopover && !activePopover.contains(ev.target)) closeActivePopover();
  }
  function popoverEsc(ev) {
    if (ev.key === "Escape") closeActivePopover();
  }
  function openPopover(node) {
    closeActivePopover();
    document.body.appendChild(node);
    activePopover = node;
    // Defer to next frame so the triggering click isn't itself an outside-click.
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", popoverOutsideClick, true);
      document.addEventListener("keydown", popoverEsc, true);
    });
  }
  function placePopover(node, anchorRect, prefer = "left") {
    const margin = 6;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let left;
    if (prefer === "right") {
      left = anchorRect.left;
    } else {
      left = anchorRect.right - w;
    }
    left = clamp(left, 8, window.innerWidth - w - 8);
    let top = anchorRect.bottom + margin;
    if (top + h > window.innerHeight - 8) {
      top = anchorRect.top - h - margin;
    }
    top = Math.max(8, top);
    node.style.left = left + "px";
    node.style.top = top + "px";
  }


  // =====================================================================
  // openColumnsPopover(entity, prefs, anchorEl, onToggle)
  //   Opens the column-visibility popover anchored under `anchorEl`.
  //   Calls `onToggle(attrName)` whenever the user flips a checkbox.
  // =====================================================================
  function openColumnsPopover(entity, prefs, anchorEl, onToggle) {
    const hidden = new Set((prefs && prefs.hidden) || []);
    const panel = el(
      `<div class="cdb-popover" role="menu"><div class="pop-header">Columns</div></div>`
    );
    for (const a of (entity && entity.attributes) || []) {
      const row = el(
        `<div class="pop-row${hidden.has(a.name) ? "" : " checked"}" role="menuitemcheckbox" tabindex="0">
          <span class="check">${ICON_CHECK}</span>
          <span class="label">${escapeHTML(a.name)}</span>
          <span class="type">${escapeHTML(a.type)}</span>
        </div>`
      );
      row.addEventListener("click", () => {
        const wasHidden = hidden.has(a.name);
        if (wasHidden) hidden.delete(a.name);
        else hidden.add(a.name);
        row.classList.toggle("checked", !hidden.has(a.name));
        onToggle && onToggle(a.name);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
      panel.appendChild(row);
    }
    openPopover(panel);
    placePopover(panel, anchorEl.getBoundingClientRect(), "left");
  }



  // =====================================================================
  // render(hostEl, opts, callbacks)
  //   opts = { entity, rows, columnPrefs, selectedId, sort }
  //   callbacks = { onRowClick, onRowDoubleClick, onSort, onColumnsChanged }
  // =====================================================================
  function render(hostEl, opts, callbacks) {
    hostEl.innerHTML = "";

    const { entity, rows, columnPrefs, selectedId, sort } = opts || {};

    if (!entity) {
      // Empty state handled by :empty::before in lab.css
      return;
    }
    if (rows == null) return;

    if (rows.length === 0) {
      hostEl.appendChild(el(`<div class="grid-empty">No records</div>`));
      return;
    }

    const prefs = columnPrefs || defaultColumnPrefs(entity);
    const attrs = visibleAttrs(entity, prefs);
    const attrMap = Object.fromEntries(entity.attributes.map((a) => [a.name, a]));
    const widths = prefs.widths || {};
    const currentSort = sort || {};

    const table = el(`<table class="cdb-grid"></table>`);
    const colgroup = document.createElement("colgroup");
    for (const name of attrs) {
      const col = document.createElement("col");
      col.dataset.attr = name;
      // Guard against stored widths <= 0 (e.g. left behind by the pre-fix
      // Safari resize bug) — fall back to the default so the column is reachable.
      const stored = widths[name];
      const w = (typeof stored === "number" && stored > 0)
        ? stored
        : defaultWidth((attrMap[name] || {}).type);
      col.style.width = w + "px";
      colgroup.appendChild(col);
    }
    // Filler column absorbs remaining table width so the row borders
    // extend to the right edge of the pane.
    const fillerCol = document.createElement("col");
    fillerCol.className = "cdb-col-filler";
    colgroup.appendChild(fillerCol);
    table.appendChild(colgroup);

    // ---- Header
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    for (const name of attrs) {
      const a = attrMap[name] || { type: "" };
      const th = document.createElement("th");
      th.dataset.attr = name;
      const klass = typeClass(a.type);
      if (klass) th.classList.add(klass);
      const sortVal = currentSort.attr === name ? currentSort.order || "asc" : "false";
      th.dataset.sorted = sortVal;
      th.innerHTML = `
        <span class="th-content">
          <span class="th-name">${escapeHTML(name)}</span>
          <span class="th-type">· ${escapeHTML(a.type)}</span>
        </span>
        <span class="th-sort">${ICON_SORT}</span>
        <span class="th-resize" aria-hidden="true"></span>
      `;
      trHead.appendChild(th);
    }
    // Filler header cell
    const fillerTh = document.createElement("th");
    fillerTh.className = "cdb-th-filler";
    trHead.appendChild(fillerTh);
    thead.appendChild(trHead);
    table.appendChild(thead);

    // ---- Body
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.id = row.id;
      if (selectedId && row.id === selectedId) tr.classList.add("selected");
      for (const name of attrs) {
        const a = attrMap[name] || { type: "" };
        const td = document.createElement("td");
        const klass = typeClass(a.type);
        if (klass) td.classList.add(klass);
        const r = renderCell(row.attrs ? row.attrs[name] : undefined, a);
        if (r.cls) td.classList.add(r.cls);
        td.innerHTML = r.html;
        if (r.title) td.title = r.title;
        tr.appendChild(td);
      }
      // Filler body cell — inherits hover/selected background from its <tr>.
      const fillerTd = document.createElement("td");
      fillerTd.className = "cdb-td-filler";
      tr.appendChild(fillerTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    hostEl.appendChild(table);

    // Drop indicator (column reorder)
    const dropIndicator = el(`<div class="cdb-drop-indicator"></div>`);
    hostEl.appendChild(dropIndicator);

    wireHeaderInteractions(table, hostEl, attrs, prefs, callbacks, dropIndicator);
    wireRowInteractions(table, callbacks);
  }


  function wireRowInteractions(table, callbacks) {
    const tbody = table.querySelector("tbody");
    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      callbacks.onRowClick && callbacks.onRowClick(tr.dataset.id);
    });
    tbody.addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      callbacks.onRowDoubleClick && callbacks.onRowDoubleClick(tr.dataset.id);
    });
  }

  function wireHeaderInteractions(table, hostEl, currentOrder, prefs, callbacks, dropIndicator) {
    const thead = table.querySelector("thead");
    const ths = Array.from(thead.querySelectorAll("th:not(.cdb-th-filler)"));

    for (const th of ths) {
      const attr = th.dataset.attr;
      const resize = th.querySelector(".th-resize");

      th.addEventListener("click", (e) => {
        if (resize.contains(e.target)) return;
        if (th.dataset.justDragged === "1") {
          delete th.dataset.justDragged;
          return;
        }
        cycleSort(th, attr, callbacks);
      });

      th.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openHeaderContextMenu(e.clientX, e.clientY, attr, prefs, callbacks);
      });

      th.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (resize.contains(e.target)) return;
        startColumnReorder(e, th, ths, hostEl, table, currentOrder, prefs, callbacks, dropIndicator);
      });

      resize.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startColumnResize(e, th, table, prefs, callbacks);
      });
    }
  }

  function cycleSort(th, attr, callbacks) {
    const cur = th.dataset.sorted;
    let nextOrder;
    if (cur === "false" || cur === "" || cur === undefined) nextOrder = "asc";
    else if (cur === "asc") nextOrder = "desc";
    else nextOrder = ""; // back to unsorted
    callbacks.onSort && callbacks.onSort(nextOrder ? attr : "", nextOrder || "asc");
  }


  function startColumnReorder(downEvt, th, allThs, hostEl, table, currentOrder, prefs, callbacks, dropIndicator) {
    const attr = th.dataset.attr;
    const startX = downEvt.clientX;
    const startY = downEvt.clientY;
    let dragging = false;
    let dropIdx = currentOrder.indexOf(attr);

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;
        th.classList.add("is-dragging");
        document.body.style.cursor = "grabbing";
      }

      // Find nearest column-gap (between or at edges of visible columns).
      const hostRect = hostEl.getBoundingClientRect();
      const gaps = [];
      for (let i = 0; i < allThs.length; i++) {
        const r = allThs[i].getBoundingClientRect();
        gaps.push({ idx: i, x: r.left });
        if (i === allThs.length - 1) gaps.push({ idx: i + 1, x: r.right });
      }
      let best = gaps[0];
      let bestDist = Infinity;
      for (const g of gaps) {
        const d = Math.abs(g.x - e.clientX);
        if (d < bestDist) { bestDist = d; best = g; }
      }
      dropIdx = best.idx;

      // Position the drop indicator relative to hostEl (its positioning context)
      dropIndicator.classList.add("visible");
      const localX = best.x - hostRect.left + hostEl.scrollLeft;
      dropIndicator.style.left = (localX - 1) + "px";
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      dropIndicator.classList.remove("visible");
      th.classList.remove("is-dragging");
      if (!dragging) return;

      // Suppress the synthetic click that fires after pointerup so we don't
      // accidentally re-sort the column the user just dragged. If no click
      // follows (e.g. pointer ended outside the th), the timer clears it.
      th.dataset.justDragged = "1";
      setTimeout(() => { delete th.dataset.justDragged; }, 0);

      const oldIdx = currentOrder.indexOf(attr);
      let insertIdx = dropIdx;
      // After removing the source from its slot, indices ≥ oldIdx shift down by 1.
      if (insertIdx > oldIdx) insertIdx -= 1;
      if (insertIdx === oldIdx) return;

      const newOrder = currentOrder.slice();
      newOrder.splice(oldIdx, 1);
      newOrder.splice(insertIdx, 0, attr);

      callbacks.onColumnsChanged && callbacks.onColumnsChanged(
        Object.assign({}, prefs, { order: mergeOrder(newOrder, prefs.order, attr) })
      );
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Merge the visible-attr reorder back into the full pref.order so hidden
  // attrs keep their relative positions.
  function mergeOrder(newVisibleOrder, fullOrder, movedAttr) {
    if (!fullOrder || !fullOrder.length) return newVisibleOrder.slice();
    const visibleSet = new Set(newVisibleOrder);
    const result = [];
    let visIdx = 0;
    for (const a of fullOrder) {
      if (visibleSet.has(a)) {
        // place the next visible attr in newVisibleOrder
        if (visIdx < newVisibleOrder.length) {
          result.push(newVisibleOrder[visIdx++]);
        }
      } else {
        result.push(a);
      }
    }
    while (visIdx < newVisibleOrder.length) result.push(newVisibleOrder[visIdx++]);
    return result;
  }


  function startColumnResize(downEvt, th, table, prefs, callbacks) {
    const attr = th.dataset.attr;
    const col = table.querySelector('col[data-attr="' + CSS.escape(attr) + '"]');
    if (!col) return;
    const startX = downEvt.clientX;
    // Safari returns 0 from getBoundingClientRect() on <col> elements (per
    // spec), so prefer the th rect and fall back to the inline style.
    const startW = th.getBoundingClientRect().width || parseInt(col.style.width, 10) || 0;
    let currentW = startW;
    const handle = th.querySelector(".th-resize");
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";

    function onMove(e) {
      currentW = clamp(startW + (e.clientX - startX), 60, 600);
      col.style.width = currentW + "px";
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      handle.classList.remove("dragging");
      callbacks.onColumnsChanged && callbacks.onColumnsChanged(
        Object.assign({}, prefs, {
          widths: Object.assign({}, prefs.widths || {}, { [attr]: Math.round(currentW) }),
        })
      );
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }


  function openHeaderContextMenu(x, y, attr, prefs, callbacks) {
    const panel = el(
      `<div class="cdb-popover" role="menu">
        <div class="pop-row" data-action="hide" role="menuitem"><span class="check"></span><span class="label">Hide column</span></div>
        <div class="pop-row" data-action="reset" role="menuitem"><span class="check"></span><span class="label">Reset width</span></div>
        <div class="pop-divider"></div>
        <div class="pop-row" data-action="show-all" role="menuitem"><span class="check"></span><span class="label">Show all columns</span></div>
      </div>`
    );
    panel.addEventListener("click", (e) => {
      const row = e.target.closest(".pop-row");
      if (!row) return;
      const action = row.dataset.action;
      if (action === "hide") {
        const hidden = ((prefs && prefs.hidden) || []).slice();
        if (!hidden.includes(attr)) hidden.push(attr);
        callbacks.onColumnsChanged && callbacks.onColumnsChanged(Object.assign({}, prefs, { hidden }));
      } else if (action === "reset") {
        const widths = Object.assign({}, (prefs && prefs.widths) || {});
        delete widths[attr];
        callbacks.onColumnsChanged && callbacks.onColumnsChanged(Object.assign({}, prefs, { widths }));
      } else if (action === "show-all") {
        callbacks.onColumnsChanged && callbacks.onColumnsChanged(Object.assign({}, prefs, { hidden: [] }));
      }
      closeActivePopover();
    });
    openPopover(panel);
    placePopover(panel, { left: x, right: x, top: y, bottom: y }, "right");
  }


  function defaultColumnPrefs(entity) {
    return {
      order: ((entity && entity.attributes) || []).map((a) => a.name),
      widths: {},
      hidden: [],
    };
  }


  return { openColumnsPopover, render, defaultColumnPrefs };
})();
window.CDBGrid = CDBGrid;


/* =======================================================================
   CDBDetail — detail / relationships / content-viewer panes (pass 3)
   View + interaction only.
   ======================================================================= */

const CDBDetail = (function () {

  // ---- Local helpers (duplicated from CDBGrid intentionally — keep IIFEs sealed) ----
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function formatBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  const NUMERIC_TYPES = new Set(["Int16", "Int32", "Int64", "Float", "Double", "Decimal"]);
  function typeClass(type) {
    if (NUMERIC_TYPES.has(type)) return "col-numeric";
    if (type === "Date") return "col-date";
    if (type === "Bool") return "col-bool";
    return "";
  }

  // Used only when no schema is passed in.
  function inferType(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object" && value.type === "binary") return "Binary";
    if (typeof value === "object" && value.type === "transformable") return "Transformable";
    if (typeof value === "object") return "?";
    if (typeof value === "boolean") return "Bool";
    if (typeof value === "number") return Number.isInteger(value) ? "Int" : "Double";
    return "String";
  }

  // Promote attrs that benefit from the bigger viewer (long strings, blobs, opaque)
  function isLargeAttr(v) {
    if (v && typeof v === "object" && (v.type === "binary" || v.type === "transformable")) return true;
    if (typeof v === "string" && (v.length > 200 || v.indexOf("\n") >= 0)) return true;
    return false;
  }

  // Types we refuse to edit (matches the server's ValueDecoding refusals).
  const READONLY_TYPES = new Set(["Transformable", "ObjectID"]);
  function isEditableType(type) { return !READONLY_TYPES.has(type); }

  const BINARY_MAX_BYTES = 10 * 1024 * 1024;

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.onload = () => {
        const s = String(r.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.readAsDataURL(file);
    });
  }


  // ---- Value renderers ------------------------------------------------

  // For the attribute-row right side.
  function renderDetailValue(value, type) {
    if (value === null || value === undefined) {
      return { html: "null", cls: "val-null" };
    }
    if (typeof value === "object" && value.type === "binary") {
      return {
        html: "binary&nbsp;·&nbsp;" + escapeHTML(formatBytes(value.bytes)),
        cls: "val-binary",
      };
    }
    if (typeof value === "object" && value.type === "transformable") {
      return { html: "transformable", cls: "val-binary" };
    }
    if (typeof value === "object") {
      return {
        html: `<code class="value-json">${escapeHTML(JSON.stringify(value, null, 2))}</code>`,
        cls: "",
      };
    }
    if (typeof value === "boolean") {
      return {
        html: value ? "true" : "false",
        cls: value ? "val-true" : "val-false",
      };
    }
    if (typeof value === "string") {
      // Wrap strings so they wrap + scroll inside a capped box.
      return { html: `<span class="value-string">${escapeHTML(value)}</span>`, cls: "" };
    }
    // Numeric / Date
    return { html: escapeHTML(String(value)), cls: "" };
  }

  // For the Content viewer (#contentBody = <pre>).
  function renderContentValue(value) {
    if (value === null || value === undefined) {
      return `<span class="cb-null">null</span>`;
    }
    if (typeof value === "object" && value.type === "binary") {
      return (
        `<span class="cb-binary">binary · ${escapeHTML(formatBytes(value.bytes))}</span>` +
        `\n<span class="cb-meta">raw bytes not available in v1 — coming in v1.2 via /api/object/blob</span>`
      );
    }
    if (typeof value === "object" && value.type === "transformable") {
      return (
        `<span class="cb-binary">transformable</span>` +
        `\n<span class="cb-meta">opaque value — viewer support coming in v1.2</span>`
      );
    }
    if (typeof value === "object") {
      return escapeHTML(JSON.stringify(value, null, 2));
    }
    if (typeof value === "boolean") {
      return value ? `<span class="cb-true">true</span>` : `<span class="cb-false">false</span>`;
    }
    return escapeHTML(String(value));
  }


  // =====================================================================
  // renderDetail(detailEl, breadcrumbEl, titleEl, dto, callbacks, entity?)
  //   entity (optional): the entity schema; if absent, types are inferred.
  //
  //   Edit-mode flags on `callbacks`:
  //     - writable: server allows mutation (capabilities include "write")
  //     - editing: render input controls instead of values; swap toolbar
  //     - onEdit / onCancelEdit / onSaveEdit / onDelete: button handlers
  // =====================================================================
  function renderDetail(detailEl, breadcrumbEl, titleEl, dto, callbacks, entity) {
    if (!dto) {
      clearDetail(detailEl, breadcrumbEl, titleEl);
      return;
    }
    callbacks = callbacks || {};
    const writable = !!callbacks.writable;
    const editing = !!callbacks.editing;

    titleEl.textContent = dto.entity || "Detail";
    breadcrumbEl.textContent = dto.id || "";

    detailEl.innerHTML = "";

    // ---- Sticky toolbar ----
    const toolbar = el(`<div class="detail-toolbar"></div>`);
    if (editing) {
      const cancel = el(`<button class="gt-btn detail-cancel" type="button">Cancel</button>`);
      cancel.addEventListener("click", () => callbacks.onCancelEdit && callbacks.onCancelEdit());
      const save = el(`<button class="gt-btn detail-save" type="button">Save</button>`);
      save.addEventListener("click", () => callbacks.onSaveEdit && callbacks.onSaveEdit());
      toolbar.appendChild(cancel);
      toolbar.appendChild(save);
    } else {
      const exportBtn = el(`<button class="gt-btn detail-export" type="button">Export JSON</button>`);
      exportBtn.addEventListener("click", () => callbacks.onExport && callbacks.onExport());
      toolbar.appendChild(exportBtn);
      if (writable) {
        const edit = el(`<button class="gt-btn detail-edit" type="button">Edit</button>`);
        edit.addEventListener("click", () => callbacks.onEdit && callbacks.onEdit());
        const del = el(`<button class="gt-btn btn-danger detail-delete" type="button">Delete</button>`);
        del.addEventListener("click", () => callbacks.onDelete && callbacks.onDelete());
        toolbar.appendChild(edit);
        toolbar.appendChild(del);
      }
    }
    detailEl.appendChild(toolbar);

    // ---- Attributes ----
    detailEl.appendChild(el(`<div class="detail-section-label">Attributes</div>`));
    const attrSection = document.createElement("div");
    attrSection.className = "attr-rows" + (editing ? " editing" : "");

    // Use schema order if available; otherwise the dto's iteration order.
    const dtoKeys = Object.keys(dto.attrs || {});
    let attrOrder;
    if (entity && Array.isArray(entity.attributes)) {
      const known = new Set(dtoKeys);
      attrOrder = entity.attributes.map((a) => a.name).filter((n) => known.has(n));
      // append any keys in dto that the schema doesn't know about
      for (const k of dtoKeys) if (!attrOrder.includes(k)) attrOrder.push(k);
    } else {
      attrOrder = dtoKeys.slice().sort();
    }
    const attrSchemaMap = {};
    const attrTypeMap = {};
    if (entity && Array.isArray(entity.attributes)) {
      for (const a of entity.attributes) {
        attrSchemaMap[a.name] = a;
        attrTypeMap[a.name] = a.type;
      }
    }

    if (attrOrder.length === 0) {
      attrSection.appendChild(el(`<div class="attr-k"><span class="name">—</span></div>`));
      attrSection.appendChild(el(`<div class="attr-v val-null">no attributes</div>`));
    } else {
      for (const name of attrOrder) {
        const value = dto.attrs[name];
        const type = attrTypeMap[name] || inferType(value);
        if (editing && isEditableType(type)) {
          appendEditableRow(attrSection, name, value, attrSchemaMap[name] || { name, type, optional: true });
        } else {
          appendAttrRow(attrSection, name, value, type, callbacks, editing);
        }
      }
    }
    detailEl.appendChild(attrSection);

    // ---- Relationships (read-only; shown in both modes) ----
    const rels = dto.relationships || [];
    if (rels.length > 0) {
      detailEl.appendChild(el(`<div class="detail-section-label">Relationships</div>`));
      const cards = document.createElement("div");
      cards.className = "rel-cards";
      for (const rel of rels) {
        cards.appendChild(renderRelCard(rel, callbacks));
      }
      detailEl.appendChild(cards);
    }

    // ---- Content viewer (hidden during edit to keep focus) ----
    if (!editing) {
      appendContentSection(detailEl, dto, callbacks, entity, attrTypeMap);
    }
  }


  // ---- Editable attribute rows ----------------------------------------

  function appendEditableRow(parent, name, value, attrSchema) {
    const type = attrSchema.type || "";
    const optional = !!attrSchema.optional;

    const k = el(
      `<div class="attr-k"><span class="name">${escapeHTML(name)}</span><span class="type">· ${escapeHTML(type)}</span></div>`
    );
    const v = document.createElement("div");
    v.className = "attr-v attr-v-edit";
    v.dataset.attr = name;
    v.dataset.type = type;
    v.dataset.optional = optional ? "1" : "0";

    const isNull = (value === null || value === undefined);
    const input = buildInputForType(type, value, isNull);
    input.classList.add("attr-input");
    v.appendChild(input);

    // For composite inputs (e.g. date+time pair), disabling is per-child.
    const editables = (input.tagName === "INPUT" || input.tagName === "TEXTAREA" || input.tagName === "SELECT")
      ? [input]
      : Array.from(input.querySelectorAll("input, textarea, select"));

    if (optional) {
      const wrap = el(`<label class="null-toggle"><input type="checkbox" class="null-cb">null</label>`);
      const cb = wrap.querySelector("input");
      cb.checked = isNull;
      for (const e of editables) e.disabled = isNull;
      cb.addEventListener("change", () => {
        for (const e of editables) e.disabled = cb.checked;
        if (!cb.checked && editables[0]) editables[0].focus();
      });
      v.appendChild(wrap);
    }

    parent.appendChild(k);
    parent.appendChild(v);
  }

  // ISO 8601 (UTC) → { date: "YYYY-MM-DD", time: "HH:mm:ss.sss" } in local time.
  function isoToLocalDateAndTime(iso) {
    if (typeof iso !== "string" || iso === "") return { date: "", time: "" };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { date: "", time: "" };
    const pad = (n, w) => String(n).padStart(w || 2, "0");
    return {
      date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
      time: pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
        + "." + pad(d.getMilliseconds(), 3),
    };
  }

  // Local "YYYY-MM-DD" + "HH:mm[:ss[.sss]]" → ISO 8601 UTC. Returns null on parse failure.
  function localDateTimeToISO(date, time) {
    if (!date) return null;
    const t = time || "00:00:00";
    const d = new Date(date + "T" + t);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function buildInputForType(type, value, isNull) {
    // String → textarea
    if (type === "String" || type === "") {
      const t = document.createElement("textarea");
      t.rows = 1;
      t.value = isNull ? "" : (typeof value === "string" ? value : "");
      t.spellcheck = false;
      // Auto-grow simple heuristic
      const sync = () => {
        t.style.height = "auto";
        t.style.height = Math.min(t.scrollHeight, 200) + "px";
      };
      requestAnimationFrame(sync);
      t.addEventListener("input", sync);
      return t;
    }
    // Bool → select
    if (type === "Bool") {
      const s = document.createElement("select");
      const optTrue = new Option("true", "true");
      const optFalse = new Option("false", "false");
      s.add(optTrue);
      s.add(optFalse);
      if (!isNull) s.value = value ? "true" : "false";
      else s.value = "true";
      return s;
    }
    // Numbers
    if (type === "Int16" || type === "Int32" || type === "Int64") {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "1";
      inp.value = isNull ? "" : (value == null ? "" : String(value));
      return inp;
    }
    if (type === "Float" || type === "Double") {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "any";
      inp.value = isNull ? "" : (value == null ? "" : String(value));
      return inp;
    }
    if (type === "Decimal") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "decimal";
      inp.value = isNull ? "" : (value == null ? "" : String(value));
      return inp;
    }
    if (type === "Date") {
      const parts = isNull ? { date: "", time: "" } : isoToLocalDateAndTime(value);
      const wrap = document.createElement("span");
      wrap.className = "date-time-pair";
      const dateInp = document.createElement("input");
      dateInp.type = "date";
      dateInp.className = "date-part";
      dateInp.value = parts.date;
      const timeInp = document.createElement("input");
      timeInp.type = "time";
      timeInp.step = "0.001";
      timeInp.className = "time-part";
      timeInp.value = parts.time;
      wrap.appendChild(dateInp);
      wrap.appendChild(timeInp);
      return wrap;
    }
    if (type === "UUID") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "00000000-0000-0000-0000-000000000000";
      inp.value = isNull ? "" : (typeof value === "string" ? value : "");
      return inp;
    }
    if (type === "URI") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "https://example.com/...";
      inp.value = isNull ? "" : (typeof value === "string" ? value : "");
      return inp;
    }
    if (type === "Binary") {
      const wrap = document.createElement("span");
      wrap.className = "binary-input";
      const meta = document.createElement("span");
      meta.className = "binary-meta";
      if (!isNull && value && typeof value === "object" && value.type === "binary") {
        meta.textContent = "current: " + formatBytes(value.bytes);
      } else {
        meta.textContent = isNull ? "(null)" : "(empty)";
      }
      const file = document.createElement("input");
      file.type = "file";
      file.className = "binary-file";
      const status = document.createElement("span");
      status.className = "binary-status";
      file.addEventListener("change", () => {
        const f = file.files && file.files[0];
        wrap._b64 = null;
        if (!f) { status.textContent = ""; status.className = "binary-status"; return; }
        if (f.size > BINARY_MAX_BYTES) {
          status.textContent = "too large (max " + formatBytes(BINARY_MAX_BYTES) + ")";
          status.className = "binary-status err";
          file.value = "";
          return;
        }
        status.textContent = "reading…";
        status.className = "binary-status";
        readFileAsBase64(f).then((b64) => {
          wrap._b64 = b64;
          status.textContent = formatBytes(f.size) + " ready";
        }).catch(() => {
          status.textContent = "read failed";
          status.className = "binary-status err";
        });
      });
      const hint = el(`<span class="binary-hint">leave empty to keep current</span>`);
      wrap.appendChild(meta);
      wrap.appendChild(file);
      wrap.appendChild(status);
      wrap.appendChild(hint);
      return wrap;
    }
    // Fallback (unknown type — treat as text)
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = isNull ? "" : (value == null ? "" : String(value));
    return inp;
  }

  // Collect the editable inputs into a typed JSON object suitable for PATCH.
  // Throws Error with a user-facing message on malformed numeric input.
  function collectEdits(detailEl) {
    const out = {};
    const rows = detailEl.querySelectorAll(".attr-v-edit");
    for (const row of rows) {
      const name = row.dataset.attr;
      const type = row.dataset.type;
      const optional = row.dataset.optional === "1";
      const nullCb = row.querySelector(".null-cb");
      const input = row.querySelector(".attr-input");
      if (!input) continue;

      if (optional && nullCb && nullCb.checked) {
        out[name] = null;
        continue;
      }

      // Binary: only include the key if a fresh file was picked. Otherwise
      // skip — the existing blob is left untouched on the server.
      if (type === "Binary") {
        if (input._b64) out[name] = input._b64;
        continue;
      }

      // Date uses a composite wrapper; collect from its two children directly.
      if (type === "Date") {
        const dateInp = input.querySelector(".date-part");
        const timeInp = input.querySelector(".time-part");
        const dStr = dateInp ? dateInp.value : "";
        const tStr = timeInp ? timeInp.value : "";
        if (!dStr && !tStr) {
          if (optional) { out[name] = null; continue; }
          throw new Error(`\`${name}\` requires a date`);
        }
        if (!dStr) throw new Error(`\`${name}\` is missing the date`);
        const iso = localDateTimeToISO(dStr, tStr);
        if (iso === null) throw new Error(`\`${name}\` is not a valid date/time`);
        out[name] = iso;
        continue;
      }

      const raw = input.value;
      if (type === "String") {
        out[name] = raw;
      } else if (type === "Bool") {
        out[name] = (raw === "true");
      } else if (type === "Int16" || type === "Int32" || type === "Int64") {
        if (raw.trim() === "") {
          if (optional) { out[name] = null; }
          else throw new Error(`\`${name}\` requires an integer`);
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n) || !Number.isInteger(n)) {
            throw new Error(`\`${name}\` must be an integer`);
          }
          out[name] = n;
        }
      } else if (type === "Float" || type === "Double") {
        if (raw.trim() === "") {
          if (optional) { out[name] = null; }
          else throw new Error(`\`${name}\` requires a number`);
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw new Error(`\`${name}\` must be a finite number`);
          out[name] = n;
        }
      } else if (type === "Decimal") {
        if (raw.trim() === "") {
          if (optional) { out[name] = null; }
          else throw new Error(`\`${name}\` requires a decimal`);
        } else {
          // Send as string to preserve precision; server parses with NSDecimalNumber.
          out[name] = raw.trim();
        }
      } else {
        // UUID / URI / unknown — strings
        if (raw === "" && optional) out[name] = null;
        else out[name] = raw;
      }
    }
    return out;
  }

  function appendContentSection(detailEl, dto, callbacks, entity, attrTypeMap) {
    const attrs = dto.attrs || {};
    let names;
    if (entity && Array.isArray(entity.attributes)) {
      const known = new Set(Object.keys(attrs));
      names = entity.attributes.map((a) => a.name).filter((n) => known.has(n));
      for (const k of Object.keys(attrs)) if (!names.includes(k)) names.push(k);
    } else {
      names = Object.keys(attrs);
    }
    if (names.length === 0) return;

    detailEl.appendChild(el(`<div class="detail-section-label">Content</div>`));

    const section = el(`
      <div class="content-section">
        <div class="content-section-head">
          <span class="label">Attribute</span>
          <select class="content-attr-select" aria-label="Attribute"></select>
        </div>
        <pre class="content-section-body"></pre>
      </div>
    `);
    const select = section.querySelector(".content-attr-select");
    const body = section.querySelector(".content-section-body");

    for (const n of names) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      select.appendChild(opt);
    }

    // Choose attribute: requested > first non-empty string > first non-null > first
    const requested = callbacks._contentAttrPref;
    let chosen = null;
    if (requested && names.includes(requested)) chosen = requested;
    if (!chosen) {
      for (const n of names) {
        const v = attrs[n];
        if (typeof v === "string" && v.length > 0) { chosen = n; break; }
      }
    }
    if (!chosen) {
      for (const n of names) if (attrs[n] !== null && attrs[n] !== undefined) { chosen = n; break; }
    }
    if (!chosen) chosen = names[0];
    select.value = chosen;

    function paint() {
      body.innerHTML = renderContentValue(attrs[select.value]);
    }
    select.addEventListener("change", () => {
      paint();
      callbacks.onAttributeChange && callbacks.onAttributeChange(select.value);
    });
    paint();

    // Notify caller of initial choice (so state persists in localStorage)
    if (callbacks.onAttributeChange) callbacks.onAttributeChange(chosen);

    detailEl.appendChild(section);
  }

  function appendAttrRow(parent, name, value, type, callbacks, editing) {
    const k = el(
      `<div class="attr-k"><span class="name">${escapeHTML(name)}</span><span class="type">· ${escapeHTML(type)}</span></div>`
    );
    const v = document.createElement("div");
    v.className = "attr-v";
    const klass = typeClass(type);
    if (klass) v.classList.add(klass);

    const r = renderDetailValue(value, type);
    if (r.cls) v.classList.add(r.cls);
    v.innerHTML = r.html;

    if (editing && READONLY_TYPES.has(type)) {
      v.appendChild(el(`<span class="readonly-tag">not editable</span>`));
    }

    if (!editing && isLargeAttr(value)) {
      const link = el(`<button type="button" class="preview-link">View in Content viewer</button>`);
      link.addEventListener("click", () => {
        callbacks.onPreviewAttr && callbacks.onPreviewAttr(name);
      });
      v.appendChild(link);
    }

    parent.appendChild(k);
    parent.appendChild(v);
  }

  function renderRelCard(rel, callbacks) {
    const hasItems = (rel.items && rel.items.length > 0) || (rel.count != null && rel.count > 0);
    const card = el(`<div class="rel-card${hasItems ? " has-items" : ""}"></div>`);

    const meta = rel.toMany
      ? `${rel.destination || "?"} · to-many · ${rel.count != null ? rel.count : rel.items.length} item${(rel.count != null ? rel.count : rel.items.length) === 1 ? "" : "s"}`
      : `${rel.destination || "?"} · to-one`;
    const head = el(
      `<div class="rel-card-head">
        <span class="rel-card-name">${escapeHTML(rel.name)}</span>
        <span class="rel-card-meta">${escapeHTML(meta)}</span>
      </div>`
    );
    card.appendChild(head);

    const list = document.createElement("ul");

    if (!rel.items || rel.items.length === 0) {
      if (!rel.toMany) {
        list.appendChild(el(`<li class="rel-empty">—</li>`));
      } else {
        list.appendChild(el(`<li class="rel-empty">(empty)</li>`));
      }
    } else {
      const visible = rel.items.slice(0, 5);
      for (const item of visible) {
        const li = el(
          `<li class="rel-item" data-id="${escapeHTML(item.id)}">
            <span class="rel-summary">${escapeHTML(item.summary)}</span>
            <span class="rel-entity">${escapeHTML(item.entity)}</span>
          </li>`
        );
        li.addEventListener("click", () => {
          callbacks.onSelectRecord && callbacks.onSelectRecord(item.id);
        });
        list.appendChild(li);
      }
      const totalItems = rel.count != null ? rel.count : rel.items.length;
      const more = totalItems - visible.length;
      if (more > 0) {
        list.appendChild(
          el(`<li class="rel-truncated">…and ${more} more</li>`)
        );
      } else if (rel.truncated) {
        list.appendChild(
          el(`<li class="rel-truncated">…more results truncated by server</li>`)
        );
      }
    }

    card.appendChild(list);
    return card;
  }




  // =====================================================================
  // clear() — wipe all four containers, restoring :empty placeholders.
  // =====================================================================
  function clearDetail(detailEl, breadcrumbEl, titleEl) {
    detailEl.innerHTML = "";
    breadcrumbEl.textContent = "";
    titleEl.textContent = "Detail";
  }
  function clear(detailEl, breadcrumbEl, titleEl) {
    clearDetail(detailEl, breadcrumbEl, titleEl);
  }


  return { renderDetail, clear, collectEdits };
})();
window.CDBDetail = CDBDetail;


/* =======================================================================
   Orchestrator — state, API, tabs, splitters, history, localStorage
   ======================================================================= */

(function () {
  "use strict";

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const els = {
    layout: $("#layout"),
    brandSub: $("#brandSub"),
    entityTabs: $("#entityTabs"),
    ctxChipWrap: $("#ctxChipWrap"),
    ctxChip: $("#ctxChip"),
    ctxSelectWrap: $("#ctxSelectWrap"),
    ctxSelect: $("#ctxSelect"),
    refreshBtn: $("#refreshBtn"),
    exportBtn: $("#exportBtn"),
    entityFilter: $("#entityFilter"),
    entityList: $("#entityList"),
    storeURL: $("#storeURL"),
    gridHeader: $("#gridHeader"),
    recordsTitle: $("#recordsTitle"),
    searchBtn: $("#searchBtn"),
    filterBtn: $("#filterBtn"),
    columnsBtn: $("#columnsBtn"),
    refreshGridBtn: $("#refreshGridBtn"),
    closeTabBtn: $("#closeTabBtn"),
    gridSearchBar: $("#gridSearchBar"),
    searchInput: $("#searchInput"),
    searchAttrSel: $("#searchAttrSel"),
    searchCloseBtn: $("#searchCloseBtn"),
    gridHost: $("#gridHost"),
    gridFooter: $("#gridFooter"),
    pageSize: $("#pageSize"),
    pageInfo: $("#pageInfo"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    detailPane: $("#detailPane"),
    detailTitle: $("#detailTitle"),
    detailBreadcrumb: $("#detailBreadcrumb"),
    detailBody: $("#detailBody"),
    status: $("#status"),
  };

  // ---- State ----
  const state = {
    contexts: [],
    context: null,
    entities: [],
    openTabs: [],          // ordered list of entity names
    activeTab: null,       // currently active entity name
    tabs: {},              // { [entityName]: { search, searchAttr, sort, order, limit, offset, records, detail, contentAttr, relName, searchOpen, editing } }
    entityFilter: "",
    writable: false,
  };

  function newTabState(entity) {
    const firstSearchable = entity && entity.attributes.find((a) => a.searchable);
    return {
      search: "",
      searchAttr: firstSearchable ? firstSearchable.name : "",
      sort: "",
      order: "asc",
      limit: 50,
      offset: 0,
      records: null,
      detail: null,
      contentAttr: lsGet(LS.contentAttr(entity ? entity.name : ""), null),
      relName: lsGet(LS.relName(entity ? entity.name : ""), null),
      searchOpen: false,
      editing: false,
    };
  }

  function activeTabState() {
    return state.activeTab ? state.tabs[state.activeTab] : null;
  }
  function activeEntity() {
    return state.entities.find((e) => e.name === state.activeTab) || null;
  }


  // ---- localStorage ----
  const LS = {
    panes: "cdb.lab.panes",
    cols: (name) => "cdb.lab.cols." + name,
    contentAttr: (name) => "cdb.lab.contentAttr." + name,
    relName: (name) => "cdb.lab.relName." + name,
    openTabs: (ctx) => "cdb.lab.openTabs." + (ctx || "_"),
    activeTab: (ctx) => "cdb.lab.activeTab." + (ctx || "_"),
    context: "cdb.context",
  };
  function lsGet(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }


  // ---- API ----
  async function api(path) {
    const res = await fetch(path);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text || "HTTP " + res.status }; }
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }
  function withCtx(qs) {
    if (state.context) qs.set("ctx", state.context);
    return qs;
  }

  // ---- Status ----
  function setStatus(msg) { els.status.textContent = msg; }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }


  // ---- Column prefs ----
  function getColumnPrefs(entity) {
    if (!entity) return null;
    const stored = lsGet(LS.cols(entity.name), null);
    if (stored && Array.isArray(stored.order) && stored.widths && Array.isArray(stored.hidden)) {
      return stored;
    }
    return CDBGrid.defaultColumnPrefs(entity);
  }
  function setColumnPrefs(entity, prefs) {
    if (!entity) return;
    lsSet(LS.cols(entity.name), prefs);
  }


  // =====================================================================
  // Tabs
  // =====================================================================
  function openEntityTab(name) {
    if (!state.entities.some((e) => e.name === name)) return;
    if (!state.openTabs.includes(name)) {
      state.openTabs.push(name);
      state.tabs[name] = newTabState(state.entities.find((e) => e.name === name));
      persistOpenTabs();
    }
    activateTab(name);
  }

  function activateTab(name) {
    if (!state.openTabs.includes(name)) return;
    state.activeTab = name;
    lsSet(LS.activeTab(state.context), name);
    renderTabs();
    renderEntityList();
    showGridChrome();
    renderActiveTabUI();
    pushURL();
    // Load records if not yet loaded for this tab
    const tab = activeTabState();
    if (tab && tab.records == null) loadRecords();
  }

  function closeTab(name) {
    const idx = state.openTabs.indexOf(name);
    if (idx === -1) return;
    state.openTabs.splice(idx, 1);
    delete state.tabs[name];
    persistOpenTabs();
    if (state.activeTab === name) {
      const next = state.openTabs[idx] || state.openTabs[idx - 1] || null;
      if (next) activateTab(next);
      else {
        state.activeTab = null;
        lsSet(LS.activeTab(state.context), null);
        renderTabs();
        renderEntityList();
        hideGridChrome();
        clearDetail();
        pushURL();
      }
    } else {
      renderTabs();
      renderEntityList();
    }
  }

  function persistOpenTabs() {
    lsSet(LS.openTabs(state.context), state.openTabs);
  }

  function renderTabs() {
    const wrap = els.entityTabs;
    wrap.innerHTML = "";
    for (const name of state.openTabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "entity-tab" + (name === state.activeTab ? " active" : "");
      btn.dataset.entity = name;
      btn.innerHTML =
        '<span class="entity-tab-label">' + escapeHTML(name) + '</span>' +
        '<span class="entity-tab-close" role="button" aria-label="Close tab" tabindex="0">' +
          '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>' +
        '</span>';
      btn.addEventListener("click", (e) => {
        if (e.target.closest(".entity-tab-close")) {
          closeTab(name);
        } else {
          activateTab(name);
        }
      });
      wrap.appendChild(btn);
    }
  }


  // =====================================================================
  // Entity list (sidebar)
  // =====================================================================
  function renderEntityList() {
    const q = state.entityFilter.trim().toLowerCase();
    els.entityList.innerHTML = "";
    for (const ent of state.entities) {
      if (q && !ent.name.toLowerCase().includes(q)) continue;
      const li = document.createElement("li");
      li.dataset.name = ent.name;
      const isOpen = state.openTabs.includes(ent.name);
      const isActive = state.activeTab === ent.name;
      if (isOpen) li.classList.add("open");
      if (isActive) li.classList.add("active");
      li.innerHTML =
        '<span class="name">' + escapeHTML(ent.name) + '</span>' +
        '<span class="count">' + ent.count + '</span>';
      li.addEventListener("click", () => openEntityTab(ent.name));
      els.entityList.appendChild(li);
    }
  }


  // =====================================================================
  // Grid chrome (show/hide based on active tab)
  // =====================================================================
  function showGridChrome() {
    els.gridHeader.hidden = false;
    els.gridFooter.hidden = false;
    els.recordsTitle.textContent = state.activeTab || "—";
    renderGrid();
    updateSearchBar();
    updatePagination();
  }
  function hideGridChrome() {
    els.gridHeader.hidden = true;
    els.gridFooter.hidden = true;
    els.gridSearchBar.hidden = true;
    els.gridHost.innerHTML = "";
  }

  function renderActiveTabUI() {
    els.recordsTitle.textContent = state.activeTab || "—";
    renderGrid();
    updateSearchBar();
    updatePagination();
    renderDetail();
  }


  // =====================================================================
  // Grid
  // =====================================================================
  function renderGrid() {
    const tab = activeTabState();
    const entity = activeEntity();
    if (!entity || !tab) {
      els.gridHost.innerHTML = "";
      return;
    }
    const prefs = getColumnPrefs(entity);
    CDBGrid.render(
      els.gridHost,
      {
        entity: entity,
        rows: tab.records ? tab.records.rows : null,
        columnPrefs: prefs,
        selectedId: tab.detail ? tab.detail.id : null,
        sort: { attr: tab.sort, order: tab.order },
      },
      {
        onRowClick: (id) => selectRecord(id),
        onRowDoubleClick: (id) => {
          const qs = withCtx(new URLSearchParams({ id }));
          window.open("/?" + qs.toString(), "_blank");
        },
        onSort: (attr, order) => {
          tab.sort = attr;
          tab.order = order || "asc";
          tab.offset = 0;
          loadRecords();
        },
        onColumnsChanged: (newPrefs) => {
          setColumnPrefs(entity, newPrefs);
          renderGrid();
        },
      }
    );
  }


  // =====================================================================
  // Search bar (icon-toggled)
  // =====================================================================
  function updateSearchBar() {
    const tab = activeTabState();
    const entity = activeEntity();
    if (!tab || !entity) {
      els.gridSearchBar.hidden = true;
      els.searchBtn.classList.remove("active");
      els.searchBtn.setAttribute("aria-pressed", "false");
      return;
    }

    const stringAttrs = entity.attributes.filter((a) => a.searchable);
    const hasSearchable = stringAttrs.length > 0;
    els.searchBtn.disabled = !hasSearchable;

    els.gridSearchBar.hidden = !tab.searchOpen || !hasSearchable;
    els.searchBtn.classList.toggle("active", tab.searchOpen);
    els.searchBtn.setAttribute("aria-pressed", String(tab.searchOpen));

    // Repopulate search-attr options
    els.searchAttrSel.innerHTML = "";
    for (const a of stringAttrs) {
      const opt = document.createElement("option");
      opt.value = a.name;
      opt.textContent = a.name;
      els.searchAttrSel.appendChild(opt);
    }
    if (tab.searchAttr && stringAttrs.some((a) => a.name === tab.searchAttr)) {
      els.searchAttrSel.value = tab.searchAttr;
    }
    if (els.searchInput.value !== tab.search) els.searchInput.value = tab.search;
  }

  function toggleSearchBar() {
    const tab = activeTabState();
    if (!tab) return;
    tab.searchOpen = !tab.searchOpen;
    updateSearchBar();
    if (tab.searchOpen) {
      setTimeout(() => els.searchInput.focus(), 0);
    }
  }


  // =====================================================================
  // Pagination
  // =====================================================================
  function updatePagination() {
    const tab = activeTabState();
    if (!tab || !tab.records) {
      els.pageInfo.textContent = "—";
      els.prevBtn.disabled = true;
      els.nextBtn.disabled = true;
      els.pageSize.value = String(tab ? tab.limit : 50);
      return;
    }
    const total = tab.records.total || 0;
    const offset = tab.records.offset || 0;
    const shown = tab.records.rows ? tab.records.rows.length : 0;
    const last = total === 0 ? 0 : Math.min(offset + shown, total);
    els.pageInfo.textContent = total === 0
      ? "0 rows"
      : (offset + 1) + "–" + last + " of " + total + " rows";
    els.prevBtn.disabled = offset <= 0;
    els.nextBtn.disabled = last >= total;
    els.pageSize.value = String(tab.limit);
  }


  // =====================================================================
  // Detail pane
  // =====================================================================
  function renderDetail() {
    const tab = activeTabState();
    if (!tab || !tab.detail) {
      clearDetail();
      return;
    }
    CDBDetail.renderDetail(
      els.detailBody,
      els.detailBreadcrumb,
      els.detailTitle,
      tab.detail,
      {
        _contentAttrPref: tab.contentAttr,
        writable: state.writable,
        editing: !!tab.editing,
        onExport: exportDetail,
        onSelectRecord: (id) => selectRecord(id),
        onPreviewAttr: (attr) => {
          tab.contentAttr = attr;
          if (state.activeTab) lsSet(LS.contentAttr(state.activeTab), attr);
          renderDetail();
        },
        onAttributeChange: (name) => {
          tab.contentAttr = name;
          if (state.activeTab) lsSet(LS.contentAttr(state.activeTab), name);
        },
        onEdit: enterEditMode,
        onCancelEdit: cancelEdit,
        onSaveEdit: saveEdit,
        onDelete: deleteRecord,
      },
      activeEntity()
    );
    els.exportBtn.disabled = false;
  }

  function enterEditMode() {
    const tab = activeTabState();
    if (!tab || !tab.detail || !state.writable) return;
    tab.editing = true;
    renderDetail();
  }

  function cancelEdit() {
    const tab = activeTabState();
    if (!tab) return;
    tab.editing = false;
    renderDetail();
  }

  async function saveEdit() {
    const tab = activeTabState();
    if (!tab || !tab.detail) return;
    let payload;
    try {
      payload = CDBDetail.collectEdits(els.detailBody);
    } catch (e) {
      setStatus("error: " + e.message);
      return;
    }
    setStatus("saving…");
    try {
      const qs = withCtx(new URLSearchParams({ id: tab.detail.id }));
      const res = await fetch("/api/object?" + qs.toString(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attrs: payload }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text || ("HTTP " + res.status) }; }
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      tab.detail = body;
      tab.editing = false;
      // Reflect updated values in the grid row, if loaded.
      if (tab.records && tab.records.rows) {
        const row = tab.records.rows.find((r) => r.id === body.id);
        if (row) row.attrs = body.attrs;
      }
      renderGrid();
      renderDetail();
      setStatus("saved");
    } catch (e) {
      setStatus("error: " + e.message);
    }
  }

  async function deleteRecord() {
    const tab = activeTabState();
    if (!tab || !tab.detail) return;
    if (!window.confirm("Delete this record? This cannot be undone.")) return;
    const deletedID = tab.detail.id;
    setStatus("deleting…");
    try {
      const qs = withCtx(new URLSearchParams({ id: deletedID }));
      const res = await fetch("/api/object?" + qs.toString(), { method: "DELETE" });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text || ("HTTP " + res.status) }; }
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      tab.detail = null;
      tab.editing = false;
      clearDetail();
      await loadRecords();
      // Sidebar counts went stale — refresh entity list (cheap).
      loadEntities();
      pushURL();
      setStatus("deleted");
    } catch (e) {
      setStatus("error: " + e.message);
    }
  }

  function clearDetail() {
    CDBDetail.clear(els.detailBody, els.detailBreadcrumb, els.detailTitle);
    els.exportBtn.disabled = true;
  }


  // =====================================================================
  // Data loading
  // =====================================================================
  async function loadHealth() {
    try {
      const h = await api("/api/health");
      els.storeURL.textContent = h.store || "";
      els.brandSub.textContent = h.readOnly ? "read-only" : "read/write";
      state.writable = !h.readOnly;
      setStatus("connected");
    } catch (e) {
      setStatus("offline: " + e.message);
    }
  }

  async function loadEntities() {
    setStatus("loading entities…");
    try {
      const qs = withCtx(new URLSearchParams());
      const suffix = qs.toString() ? "?" + qs.toString() : "";
      state.entities = await api("/api/entities" + suffix);
      renderEntityList();
      setStatus(state.entities.length + " entities");
    } catch (e) {
      setStatus("error: " + e.message);
    }
  }

  async function loadRecords() {
    const tab = activeTabState();
    const entity = activeEntity();
    if (!tab || !entity) return;

    const qs = withCtx(new URLSearchParams());
    if (tab.search) qs.set("search", tab.search);
    if (tab.searchAttr) qs.set("searchAttr", tab.searchAttr);
    if (tab.sort) { qs.set("sort", tab.sort); qs.set("order", tab.order); }
    qs.set("limit", tab.limit);
    qs.set("offset", tab.offset);

    setStatus("loading " + entity.name + "…");
    try {
      const page = await api("/api/entities/" + encodeURIComponent(entity.name) + "?" + qs.toString());
      tab.records = page;
      renderGrid();
      updatePagination();
      setStatus(page.total + " rows in " + entity.name);
    } catch (e) {
      setStatus("error: " + e.message);
      els.gridHost.innerHTML = '<div class="grid-empty">' + escapeHTML(e.message) + "</div>";
    }
  }

  async function selectRecord(id) {
    const tab = activeTabState();
    if (!tab) return;
    setStatus("loading record…");
    try {
      const qs = withCtx(new URLSearchParams({ id }));
      const dto = await api("/api/object?" + qs.toString());
      tab.detail = dto;
      renderGrid();
      renderDetail();
      pushURL();
      setStatus(dto.entity);
    } catch (e) {
      setStatus("error: " + e.message);
    }
  }

  function exportDetail() {
    const tab = activeTabState();
    if (!tab || !tab.detail) return;
    const qs = withCtx(new URLSearchParams({ id: tab.detail.id }));
    window.location.href = "/api/object/export?" + qs.toString();
  }


  // =====================================================================
  // Contexts (top-bar chip / dropdown)
  // =====================================================================
  async function loadContexts() {
    try {
      state.contexts = await api("/api/contexts");
      const preferred = lsGet(LS.context, null);
      if (preferred && state.contexts.some((c) => c.name === preferred)) {
        state.context = preferred;
      } else {
        const def = state.contexts.find((c) => c.isDefault);
        state.context = def ? def.name : (state.contexts[0] ? state.contexts[0].name : null);
      }
      renderContextChip();
    } catch {
      state.contexts = [];
      state.context = null;
      renderContextChip();
    }
  }

  function renderContextChip() {
    if (!els.ctxChipWrap) return;
    const ctxs = state.contexts;
    if (ctxs.length === 0) {
      els.ctxChipWrap.hidden = true;
      return;
    }
    els.ctxChipWrap.hidden = false;
    if (ctxs.length === 1) {
      els.ctxChip.hidden = false;
      els.ctxSelectWrap.hidden = true;
      els.ctxChip.textContent = ctxs[0].name;
      els.ctxChip.title = ctxs[0].store || ctxs[0].name;
    } else {
      els.ctxChip.hidden = true;
      els.ctxSelectWrap.hidden = false;
      els.ctxSelect.innerHTML = "";
      for (const c of ctxs) {
        const opt = document.createElement("option");
        opt.value = c.name;
        opt.textContent = c.name;
        if (c.name === state.context) opt.selected = true;
        els.ctxSelect.appendChild(opt);
      }
    }
  }

  async function switchContext(name) {
    if (state.context === name) return;
    state.context = name;
    lsSet(LS.context, name);
    // Reset tab + entity state — different contexts can have different models
    state.openTabs = [];
    state.tabs = {};
    state.activeTab = null;
    state.entities = [];
    clearDetail();
    hideGridChrome();
    renderTabs();
    renderEntityList();
    renderContextChip();
    await loadEntities();
    await restoreOpenTabs();
  }


  // =====================================================================
  // URL state
  // =====================================================================
  function pushURL() {
    const qs = withCtx(new URLSearchParams());
    if (state.activeTab) qs.set("entity", state.activeTab);
    const tab = activeTabState();
    if (tab && tab.detail) qs.set("id", tab.detail.id);
    const url = qs.toString() ? "/?" + qs.toString() : "/";
    history.replaceState({ entity: state.activeTab, ctx: state.context }, "", url);
  }

  async function initFromURL() {
    const qs = new URLSearchParams(window.location.search);
    const urlCtx = qs.get("ctx");
    if (urlCtx && state.contexts.some((c) => c.name === urlCtx)) {
      state.context = urlCtx;
      renderContextChip();
    }

    const urlEntity = qs.get("entity");
    const urlId = qs.get("id");

    if (urlId) {
      // Find the entity for this record
      try {
        const oqs = withCtx(new URLSearchParams({ id: urlId }));
        const dto = await api("/api/object?" + oqs.toString());
        if (dto.entity) {
          openEntityTab(dto.entity);
          const tab = activeTabState();
          if (tab) {
            tab.detail = dto;
            renderGrid();
            renderDetail();
            pushURL();
            return true;
          }
        }
      } catch {}
    }
    if (urlEntity && state.entities.some((e) => e.name === urlEntity)) {
      openEntityTab(urlEntity);
      return true;
    }
    return false;
  }

  async function restoreOpenTabs() {
    const saved = lsGet(LS.openTabs(state.context), []);
    const valid = (saved || []).filter((n) => state.entities.some((e) => e.name === n));
    for (const name of valid) {
      if (!state.openTabs.includes(name)) {
        state.openTabs.push(name);
        state.tabs[name] = newTabState(state.entities.find((e) => e.name === name));
      }
    }
    const lastActive = lsGet(LS.activeTab(state.context), null);
    if (lastActive && state.openTabs.includes(lastActive)) {
      activateTab(lastActive);
    } else if (state.openTabs.length > 0) {
      activateTab(state.openTabs[0]);
    } else {
      renderTabs();
      renderEntityList();
      hideGridChrome();
    }
  }


  // =====================================================================
  // Splitters
  // =====================================================================
  function setupSplitters() {
    els.layout.querySelectorAll(".splitter").forEach((sp) => {
      sp.addEventListener("pointerdown", (e) => startSplitterDrag(sp, e));
    });
    restorePanes();
  }
  function startSplitterDrag(sp, downEvt) {
    if (downEvt.button !== 0) return;
    downEvt.preventDefault();
    try { sp.setPointerCapture(downEvt.pointerId); } catch {}
    sp.classList.add("dragging");
    els.layout.classList.add("dragging");
    const target = sp.dataset.target;
    const startX = downEvt.clientX;
    const style = getComputedStyle(els.layout);
    const startSidebar = parseFloat(style.getPropertyValue("--sidebar-w")) || 240;
    const startDetail = parseFloat(style.getPropertyValue("--detail-w")) || 340;

    function move(e) {
      const dx = e.clientX - startX;
      if (target === "sidebar-center") {
        const w = Math.max(200, Math.min(window.innerWidth * 0.5, startSidebar + dx));
        els.layout.style.setProperty("--sidebar-w", w + "px");
      } else if (target === "center-detail") {
        const w = Math.max(240, Math.min(window.innerWidth * 0.7, startDetail - dx));
        els.layout.style.setProperty("--detail-w", w + "px");
      }
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      sp.classList.remove("dragging");
      els.layout.classList.remove("dragging");
      savePanes();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function savePanes() {
    lsSet(LS.panes, {
      sidebar: els.layout.style.getPropertyValue("--sidebar-w"),
      detail:  els.layout.style.getPropertyValue("--detail-w"),
    });
  }
  function restorePanes() {
    const p = lsGet(LS.panes, null);
    if (!p) return;
    if (p.sidebar) els.layout.style.setProperty("--sidebar-w", p.sidebar);
    if (p.detail)  els.layout.style.setProperty("--detail-w", p.detail);
  }


  // =====================================================================
  // Wiring + bootstrap
  // =====================================================================
  function debounce(fn, ms) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
  }

  function wireUI() {
    setupSplitters();

    els.refreshBtn.addEventListener("click", refreshAll);
    els.refreshGridBtn.addEventListener("click", () => { loadRecords(); });
    els.exportBtn.addEventListener("click", exportDetail);
    els.closeTabBtn.addEventListener("click", () => {
      if (state.activeTab) closeTab(state.activeTab);
    });

    if (els.ctxSelect) {
      els.ctxSelect.addEventListener("change", () => switchContext(els.ctxSelect.value));
    }

    els.entityFilter.addEventListener("input", () => {
      state.entityFilter = els.entityFilter.value;
      renderEntityList();
    });

    els.searchBtn.addEventListener("click", toggleSearchBar);
    els.searchCloseBtn.addEventListener("click", () => {
      const tab = activeTabState();
      if (!tab) return;
      tab.searchOpen = false;
      if (tab.search) {
        tab.search = "";
        tab.offset = 0;
        els.searchInput.value = "";
        loadRecords();
      }
      updateSearchBar();
    });

    els.searchInput.addEventListener("input", debounce(() => {
      const tab = activeTabState();
      if (!tab) return;
      tab.search = els.searchInput.value;
      tab.offset = 0;
      loadRecords();
    }, 250));

    els.searchAttrSel.addEventListener("change", () => {
      const tab = activeTabState();
      if (!tab) return;
      tab.searchAttr = els.searchAttrSel.value;
      if (tab.search) loadRecords();
    });

    els.columnsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const entity = activeEntity();
      if (!entity) return;
      CDBGrid.openColumnsPopover(entity, getColumnPrefs(entity), els.columnsBtn, (attr) => {
        const prefs = getColumnPrefs(entity);
        const hidden = new Set(prefs.hidden || []);
        if (hidden.has(attr)) hidden.delete(attr); else hidden.add(attr);
        const newPrefs = Object.assign({}, prefs, { hidden: Array.from(hidden) });
        setColumnPrefs(entity, newPrefs);
        renderGrid();
      });
    });

    els.pageSize.addEventListener("change", () => {
      const tab = activeTabState();
      if (!tab) return;
      tab.limit = parseInt(els.pageSize.value, 10) || 50;
      tab.offset = 0;
      loadRecords();
    });
    els.prevBtn.addEventListener("click", () => {
      const tab = activeTabState();
      if (!tab) return;
      tab.offset = Math.max(0, tab.offset - tab.limit);
      loadRecords();
    });
    els.nextBtn.addEventListener("click", () => {
      const tab = activeTabState();
      if (!tab) return;
      tab.offset += tab.limit;
      loadRecords();
    });
  }

  async function refreshAll() {
    setStatus("refreshing…");
    await loadHealth();
    await loadContexts();
    await loadEntities();
    if (state.activeTab && state.entities.some((e) => e.name === state.activeTab)) {
      await loadRecords();
      const tab = activeTabState();
      if (tab && tab.detail) {
        try {
          const qs = withCtx(new URLSearchParams({ id: tab.detail.id }));
          tab.detail = await api("/api/object?" + qs.toString());
          renderGrid();
          renderDetail();
        } catch {}
      }
    }
    setStatus("refreshed");
  }

  async function bootstrap() {
    wireUI();
    await loadHealth();
    await loadContexts();
    await loadEntities();

    const fromURL = await initFromURL();
    if (!fromURL) {
      await restoreOpenTabs();
    }

    window.addEventListener("popstate", () => {
      initFromURL();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();

