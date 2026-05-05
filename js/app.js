/* =============================================================
   Fahrrad XXL - Montage Dashboard
   Main application logic:
   - State management
   - Filter change = new API call + tables get rebuilt
   - Default filter (today + older-than-10-days) loaded on init
   - Tab switching
   - KPI/Chart/Table rendering
   ============================================================= */

(function () {
  "use strict";

  /* -------- 0. Redirect to login if no token -------- */
  if (!Auth.requireAuth()) return;

  /* =========================================================
     1.  STATE
     ========================================================= */
  const state = {
    tab:       "offene",
    filter: {
      range: APP_CONFIG.DEFAULT_RANGE,
      from:  null,
      to:    null,
      marke:     "",
      kategorie: "",
      // Neue Filter:
      pickstatus:    "",           // "", "offen", "vormontage", "montage", "montiert", "verpackung", "warenausgang", "storniert"
      lagerplatz:    "",           // einzelner Stations-Code wie "G0202", "Verpack_1", "Montage"
      montiertOnly:  null,         // null=alle, true=nur Montage abgeschlossen, false=nur Montage NICHT abgeschlossen
      verpacktOnly:  null          // null=alle, true=nur Verpackung abgeschlossen, false=nicht
    },
    settings: {
      monteure:  APP_CONFIG.DEFAULT_MONTEURE,
      stunden:   APP_CONFIG.DEFAULT_STUNDEN,
      workdays:  [...APP_CONFIG.DEFAULT_WORKDAYS]
    },
    data: {
      offene:     { rows: [] },
      fakturiert: { rows: [] },
      daily:      null,
      monthly:    null,
      aufbauzeiten: null
    },
    loaded: {
      offene:     false,
      fakturiert: false,
      daily:      false,
      monthly:    false
    },
    // Sort + pagination are per-table.
    // sortKey="default" = Priority-Ranking aus user-Wunsch:
    //   Offen > Vormontage > Montage > Verpackung > Warenausgang > Montiert > Storniert
    //   intern: aelteste, dann hoechste UVP, dann niedrigste Montagezeit
    table: {
      offene: { sortKey: "default", sortDir: "asc",  page: 1, pageSize: 50 },
      fakt:   { sortKey: "datum",   sortDir: "desc", page: 1, pageSize: 50 },
      uebersicht: { sortKey: "menge_offen", sortDir: "desc", page: 1, pageSize: 50 }
    }
  };

  /* Remember last search text per tab */
  const searchState = { offene: "", fakt: "" };

  const FILTER_LABELS = {
    default:  "Standard (heute + ältere > 10 Tage)",
    today:    "Heute",
    week:     "Diese Woche",
    month:    "Dieser Monat",
    older10:  "Ältere > 10 Tage",
    all:      "Alle Zeiträume",
    custom:   "Benutzerdefiniert"
  };

  /* =========================================================
     2.  BOOT
     ========================================================= */
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    initUserChip();
    initClock();
    initNavTabs();
    initSettings();
    initFilterBar();
    initFilterDropdowns();
    initSearches();
    initExports();
    initLogout();
    initMenuToggle();
    initRefresh();
    initSorting();
    initPagers();
    initUebersicht();          // Search/Pager/Drawer der Übersicht
    initLogoutCleanup();       // Cache leeren beim Logout/Window-Close

    // ====================================================================
    // Snapshot-First: 1 Anfrage holt ALLES (offene + fakturierte 2J +
    // Daily + Monthly + Aufbauzeiten + WHS-Pickstatus inline). Wenn der
    // Snapshot da ist, nutzen wir ausschliesslich den. Falls er fehlt
    // (Erst-Setup, Storage down) -> Fallback auf die einzelnen Endpoints.
    // ====================================================================
    let snapshotLoaded = false;
    try {
      showLoader("Lade Tagesdaten…");
      const snap = await API.snapshot();
      if (snap && snap.offene && Array.isArray(snap.offene.rows)) {
        applySnapshot(snap);
        snapshotLoaded = true;
        showSnapshotBanner(snap);
      }
    } catch (err) {
      console.warn("Snapshot nicht verfügbar, fallback auf Einzel-Endpoints:", err);
    } finally {
      hideLoader();
    }

    if (snapshotLoaded) {
      // Direkt rendern – alle Daten sind da.
      reRenderCurrentTab();
    } else {
      // Fallback: alter Lade-Pfad
      try { state.data.aufbauzeiten = await API.aufbauzeiten(); } catch (_) {}
      await reloadCurrentTab(true);
      if (!state.loaded.fakturiert) loadFakturiert().catch(() => {});
      if (!state.loaded.daily)      loadDaily().catch(() => {});
      if (!state.loaded.monthly)    loadMonthly().catch(() => {});
    }
  }

  /* Snapshot in den state schreiben + alle Loaded-Flags setzen.
     Sonderfall: wenn der Snapshot fakturiert NICHT enthaelt (note gesetzt),
     bleibt loaded.fakturiert=false und das Frontend laedt sie on demand
     ueber /fakturierte-auftraege wenn der User den Tab oeffnet. */
  function applySnapshot(snap) {
    if (!snap) return;
    state.data.offene.rows                = snap.offene.rows;
    state.data.offene.pickstatusOverview  = snap.offene.pickstatusOverview;
    state.data.daily                      = snap.daily;
    state.data.monthly                    = snap.monthly;
    state.data.aufbauzeiten               = snap.aufbauzeiten;
    state.data.snapshotGeneratedAt        = snap.generatedAt;
    state.data.snapshotCounts             = snap.counts || {};

    state.loaded.offene  = true;
    state.loaded.daily   = true;
    state.loaded.monthly = true;

    // Fakturierte: nur als geladen markieren wenn echte Daten drin sind
    const faktNote = snap.fakturiert && snap.fakturiert.note;
    const faktRows = (snap.fakturiert && snap.fakturiert.rows) || [];
    if (faktNote || faktRows.length === 0) {
      // Snapshot enthaelt keine fakturierten -> on-demand nachladen
      state.data.fakturiert.rows = [];
      state.loaded.fakturiert    = false;
      // Im Hintergrund schon mal anstossen, damit der Tab sofort befuellt ist
      // wenn der User hinklickt.
      loadFakturiert().catch(() => {});
    } else {
      state.data.fakturiert.rows = faktRows;
      state.loaded.fakturiert    = true;
    }

    refreshFilterDropdowns();
  }

  /* Kleines Info-Badge im Filter-Meta zeigt Snapshot-Alter + Rebuild-Button. */
  function showSnapshotBanner(snap) {
    const meta = document.getElementById("filterMeta");
    if (!meta) return;
    let chip = document.getElementById("snapshotChip");
    if (!chip) {
      chip = document.createElement("span");
      chip.id = "snapshotChip";
      chip.className = "snapshot-chip";
      meta.appendChild(chip);
    }
    const ageMs = Date.now() - new Date(snap.generatedAt).getTime();
    const ageH  = ageMs / (60 * 60 * 1000);
    const cls = (ageH < 12) ? "ok" : (ageH < 24) ? "warn" : "err";
    const at  = new Date(snap.generatedAt).toLocaleString(APP_CONFIG.LOCALE,
      { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    chip.className = `snapshot-chip badge ${cls}`;
    chip.title = `Snapshot vom ${at}`;
    chip.innerHTML = `Snapshot ${at} · <a href="#" id="snapRebuild">aktualisieren</a>`;
    const a = document.getElementById("snapRebuild");
    if (a) a.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm("Snapshot neu bauen? Dauert 1–3 Minuten.")) return;
      try {
        showLoader("Snapshot wird neu gebaut – bitte ~2 Minuten warten…");
        await API.rebuildSnapshot();
        const fresh = await API.snapshot();
        if (fresh) {
          applySnapshot(fresh);
          showSnapshotBanner(fresh);
          reRenderCurrentTab();
          toast("Snapshot aktualisiert.", "ok");
        }
      } catch (err) {
        toast("Rebuild fehlgeschlagen: " + (err.message || err), "err");
      } finally {
        hideLoader();
      }
    });
  }

  function initUebersicht() {
    // Sortable Header (uebersicht-Tabelle)
    const tbl = document.getElementById("tableUebersicht");
    if (tbl) {
      tbl.querySelectorAll("thead th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
          const key = th.dataset.sort;
          const s = state.table.uebersicht;
          if (s.sortKey === key) s.sortDir = (s.sortDir === "asc") ? "desc" : "asc";
          else { s.sortKey = key; s.sortDir = "desc"; }
          s.page = 1;
          renderUbTable();
        });
      });
    }
    // Pager
    const pager = document.querySelector('.pager[data-table="uebersicht"]');
    if (pager) {
      pager.querySelector(".page-size").addEventListener("change", (e) => {
        state.table.uebersicht.pageSize = parseInt(e.target.value, 10) || 50;
        state.table.uebersicht.page = 1;
        renderUbTable();
      });
      pager.querySelector(".page-prev").addEventListener("click", () => {
        if (state.table.uebersicht.page > 1) { state.table.uebersicht.page--; renderUbTable(); }
      });
      pager.querySelector(".page-next").addEventListener("click", () => {
        state.table.uebersicht.page++; renderUbTable();
      });
    }
    // Search
    const sb = document.getElementById("searchUebersicht");
    if (sb) sb.addEventListener("input", () => {
      _ubSearch = sb.value.trim().toLowerCase();
      renderUbTable();
    });
    // Export
    const ex = document.getElementById("exportUebersicht");
    if (ex) ex.addEventListener("click", () => {
      const cols = [
        { key: "itemid",         label: "Artikel" },
        { key: "marke",          label: "Marke" },
        { key: "modell",         label: "Modell" },
        { key: "fahrradtyp",     label: "Fahrradtyp" },
        { key: "uvp",            label: "UVP (€)", type: "eur" },
        { key: "menge_offen",    label: "Offen Stk", type: "num" },
        { key: "menge_fakt",     label: "Faktur. Stk", type: "num" },
        { key: "cnt_montiert",   label: "Montiert", type: "num" },
        { key: "cnt_in_montage", label: "In Montage", type: "num" },
        { key: "cnt_offen",      label: "Noch n. mont.", type: "num" },
        { key: "alter_max",      label: "Älteste off. (T)", type: "num" },
        { key: "datum_letzte",   label: "Letzter Auftrag", type: "date" }
      ];
      exportXlsx("montage-uebersicht.xlsx", _ubAggregate || [], cols, "Montage Übersicht");
    });
    // Drawer-Close
    const cl = document.getElementById("ubDrawerClose");
    if (cl) cl.addEventListener("click", closeUbDrawer);
    const dr = document.getElementById("ubDrawer");
    if (dr) dr.addEventListener("click", (e) => {
      if (e.target === dr) closeUbDrawer();
    });
  }

  function initLogoutCleanup() {
    // Preload-Cache muss spaetestens beim Schliessen weg.
    window.addEventListener("beforeunload", clearAllCache);
  }
  function clearAllCache() {
    state.data.offene = { rows: [] };
    state.data.fakturiert = { rows: [] };
    state.data.daily = null;
    state.data.monthly = null;
    state.loaded.offene = false;
    state.loaded.fakturiert = false;
    state.loaded.daily = false;
    state.loaded.monthly = false;
    _ubAggregate = null;
  }

  /* =========================================================
     3.  UI WIRE-UP
     ========================================================= */

  function initUserChip() {
    const u = Auth.getUser();
    const name = (u && u.user) || "user";
    document.getElementById("userName").textContent = name;
    document.getElementById("userAvatar").textContent =
      name.substring(0, 2).toUpperCase();
    const lagerEl = document.getElementById("userLagerort");
    if (lagerEl) {
      const wid  = (u && u.warehouseId) || "";
      const name2 = (u && u.lagerort) || APP_CONFIG.LAGERORT || "–";
      lagerEl.textContent = wid ? `${name2} · ${wid}` : name2;
    }
  }

  function initClock() {
    const el = document.getElementById("clock");
    function tick() {
      const now = new Date();
      const d = now.toLocaleDateString(APP_CONFIG.LOCALE, { weekday: "short", day: "2-digit", month: "short" });
      const t = now.toLocaleTimeString(APP_CONFIG.LOCALE, { hour: "2-digit", minute: "2-digit" });
      el.textContent = `${d} · ${t}`;
    }
    tick();
    setInterval(tick, 30 * 1000);
  }

  function initNavTabs() {
    document.querySelectorAll(".nav-item[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;

    document.querySelectorAll(".nav-item[data-tab]").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach(p =>
      p.classList.toggle("active", p.id === "tab-" + tab));

    // Update page title
    const titles = {
      offene:    ["Offene Aufträge",     "Übersicht aller offenen Montageaufträge."],
      fakturiert:["Fakturierte Aufträge","Abgeschlossene, fakturierte Montageaufträge."],
      uebersicht:["Montage-Übersicht",   "Aggregat pro Artikelnummer aus offenen + fakturierten Aufträgen."],
      daily:     ["Daily Tracking",      "Tagesauswertung der Montage-Leistung."]
    };
    const [t, s] = titles[tab] || ["", ""];
    document.getElementById("pageTitle").textContent = t;
    document.getElementById("pageSub").textContent   = s;

    reloadCurrentTab();
  }

  function initSettings() {
    // Steppers
    document.querySelectorAll(".num-stepper button").forEach(btn => {
      btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.target);
        const step  = parseFloat(btn.dataset.step) * (btn.dataset.dec ? 0.5 : 1);
        input.value = Math.max(
          parseFloat(input.min || "-Infinity"),
          Math.min(parseFloat(input.max || "Infinity"),
                   (parseFloat(input.value) || 0) + step));
        fireSettingsChange();
      });
    });
    document.getElementById("setMonteure").addEventListener("input", fireSettingsChange);
    document.getElementById("setStunden").addEventListener("input", fireSettingsChange);
    document.querySelectorAll("#dayPicker input").forEach(cb =>
      cb.addEventListener("change", fireSettingsChange));
    fireSettingsChange();   // initialize readout
  }

  function fireSettingsChange() {
    const m = Math.max(1, parseInt(document.getElementById("setMonteure").value, 10) || 1);
    const h = Math.max(0.5, parseFloat(document.getElementById("setStunden").value) || 0.5);
    const days = [...document.querySelectorAll("#dayPicker input:checked")].map(c => parseInt(c.value, 10));

    state.settings.monteure = m;
    state.settings.stunden  = h;
    state.settings.workdays = days;

    const capDay  = m * h;
    const capWeek = capDay * days.length;
    document.getElementById("capPerDay").textContent  = fmtNumber(capDay, 1)  + " Std";
    document.getElementById("capPerWeek").textContent = fmtNumber(capWeek, 1) + " Std";

    // Re-render KPIs that depend on capacity (don't refetch)
    renderOffeneKpis();
    renderDailyTable();
    renderDailyKpis();
  }

  function initFilterBar() {
    document.querySelectorAll(".filter-chips .chip").forEach(chip => {
      chip.addEventListener("click", () => setRange(chip.dataset.range));
    });
    document.getElementById("applyCustom").addEventListener("click", () => {
      const from = document.getElementById("dateFrom").value;
      const to   = document.getElementById("dateTo").value;
      if (!from || !to) {
        toast("Bitte beide Datumsfelder ausfüllen.", "warn");
        return;
      }
      state.filter.range = "custom";
      state.filter.from  = from;
      state.filter.to    = to;
      markActiveChip("custom");
      updateFilterLabel();
      invalidateAndReload();
    });
    updateFilterLabel();
  }

  function setRange(range) {
    state.filter.range = range;
    state.filter.from  = null;
    state.filter.to    = null;
    markActiveChip(range);
    document.getElementById("filterCustom")
      .classList.toggle("hidden", range !== "custom");
    if (range === "custom") return;     // wait for apply
    updateFilterLabel();
    invalidateAndReload();
  }

  function markActiveChip(range) {
    document.querySelectorAll(".filter-chips .chip").forEach(c =>
      c.classList.toggle("chip-active", c.dataset.range === range));
  }

  function updateFilterLabel() {
    let label = FILTER_LABELS[state.filter.range] || "";
    if (state.filter.range === "custom" && state.filter.from && state.filter.to) {
      label = `${fmtDate(state.filter.from)} – ${fmtDate(state.filter.to)}`;
    }
    const extra = [];
    if (state.filter.marke)         extra.push("Marke: " + state.filter.marke);
    if (state.filter.kategorie)     extra.push("Kategorie: " + state.filter.kategorie);
    if (state.filter.pickstatus)    extra.push("Pickstatus: " + state.filter.pickstatus);
    if (state.filter.lagerplatz)    extra.push("Lagerplatz: " + state.filter.lagerplatz);
    if (state.filter.montiertOnly === true)  extra.push("Montage abg.");
    if (state.filter.montiertOnly === false) extra.push("Montage offen");
    if (state.filter.verpacktOnly === true)  extra.push("Verpackt");
    if (state.filter.verpacktOnly === false) extra.push("Nicht verpackt");
    if (extra.length) label += "  ·  " + extra.join("  ·  ");
    document.getElementById("filterLabel").textContent = label;
  }

  /* -------- Filter dropdowns (Marke / Kategorie / Pickstatus / Lagerplatz / Toggles) -------- */
  function initFilterDropdowns() {
    document.getElementById("filterMarke").addEventListener("change", (e) => {
      state.filter.marke = e.target.value;
      updateFilterLabel();
      invalidateAndReload();
    });
    document.getElementById("filterKategorie").addEventListener("change", (e) => {
      state.filter.kategorie = e.target.value;
      updateFilterLabel();
      invalidateAndReload();
    });

    // Diese sind CLIENT-SIDE Filter → kein Reload, nur Re-Render
    const ps = document.getElementById("filterPickstatus");
    if (ps) ps.addEventListener("change", (e) => {
      state.filter.pickstatus = e.target.value;
      updateFilterLabel();
      reRenderCurrentTab();
    });
    const lp = document.getElementById("filterLagerplatz");
    if (lp) lp.addEventListener("change", (e) => {
      state.filter.lagerplatz = e.target.value;
      updateFilterLabel();
      reRenderCurrentTab();
    });
    const fm = document.getElementById("filterMontiert");
    if (fm) fm.addEventListener("change", (e) => {
      const v = e.target.value;
      state.filter.montiertOnly = v === "ja" ? true : v === "nein" ? false : null;
      updateFilterLabel();
      reRenderCurrentTab();
    });
    const fv = document.getElementById("filterVerpackt");
    if (fv) fv.addEventListener("change", (e) => {
      const v = e.target.value;
      state.filter.verpacktOnly = v === "ja" ? true : v === "nein" ? false : null;
      updateFilterLabel();
      reRenderCurrentTab();
    });

    document.getElementById("resetFilters").addEventListener("click", () => {
      state.filter.marke = "";
      state.filter.kategorie = "";
      state.filter.pickstatus = "";
      state.filter.lagerplatz = "";
      state.filter.montiertOnly = null;
      state.filter.verpacktOnly = null;
      ["filterMarke","filterKategorie","filterPickstatus","filterLagerplatz","filterMontiert","filterVerpackt"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      updateFilterLabel();
      invalidateAndReload();
    });
  }

  function reRenderCurrentTab() {
    if (state.tab === "offene")          renderOffeneAll();
    else if (state.tab === "fakturiert") renderFakturiertAll();
    else if (state.tab === "uebersicht") renderUebersichtAll();
  }

  // Erkennt einen Lagerplatz-/Stations-Code:
  //  - klassisch: 1-2 Buchstaben + 3+ Ziffern (z. B. G0202, B9838, U892892, F2505)
  //  - Verpack_<Nummer>  bzw. Verpack_<irgendwas>  (Verpack_1, Verpack_2, Verpack_ZU, ...)
  //  - feste Stationen: Montage, Warenausgang, Vormontage
  const LAGERPLATZ_RE  = /^[a-z]{1,2}\d{3,}$/i;
  const VERPACK_RE     = /^verpack[_-].+/i;
  const KNOWN_FIX = new Set(["montage", "vormontage", "warenausgang"]);
  function isLagerplatzCode(s) {
    if (!s) return false;
    const t = String(s).trim();
    if (LAGERPLATZ_RE.test(t)) return true;
    if (VERPACK_RE.test(t))    return true;
    return KNOWN_FIX.has(t.toLowerCase());
  }

  function refreshFilterDropdowns() {
    // Compile options from both offene and fakturiert
    const markenSet = new Set(), katSet = new Set(), lagerSet = new Set();
    const push = (arr) => (arr || []).forEach(r => {
      if (r.marke)      markenSet.add(r.marke);
      if (r.fahrradtyp) katSet.add(r.fahrradtyp);
      (r.stationen || []).forEach(s => {
        const loc = (s.location || "").trim();
        if (loc && isLagerplatzCode(loc)) lagerSet.add(loc);
      });
    });
    push(state.data.offene.rows);
    push(state.data.fakturiert.rows);

    populateSelect("filterMarke",      markenSet, "Alle Marken",       state.filter.marke);
    populateSelect("filterKategorie",  katSet,    "Alle Kategorien",   state.filter.kategorie);
    populateSelect("filterLagerplatz", lagerSet,  "Alle Lagerplätze",  state.filter.lagerplatz);
  }

  function populateSelect(id, values, allLabel, current) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const items = [...values].sort((a, b) => a.localeCompare(b, APP_CONFIG.LOCALE));
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      items.map(v => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(v)}</option>`).join("");
  }

  /* -------- Sorting -------- */
  function initSorting() {
    document.querySelectorAll("table.sortable").forEach(t => {
      const tbl = t.id === "tableOffene" ? "offene" : t.id === "tableFakt" ? "fakt" : null;
      if (!tbl) return;
      t.querySelectorAll("thead th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
          const key = th.dataset.sort;
          const s = state.table[tbl];
          if (s.sortKey === key) s.sortDir = (s.sortDir === "asc") ? "desc" : "asc";
          else { s.sortKey = key; s.sortDir = "asc"; }
          s.page = 1;
          if (tbl === "offene") renderOffeneTable();
          else                  renderFaktTable();
        });
      });
    });
  }

  function applySort(rows, key, dir) {
    if (!key) return rows;
    if (key === "default") return defaultRanking(rows);
    const factor = dir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const va = a[key], vb = b[key];
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb) && typeof va !== "string") {
        return (na - nb) * factor;
      }
      return String(va || "").localeCompare(String(vb || ""),
        APP_CONFIG.LOCALE, { numeric: true, sensitivity: "base" }) * factor;
    });
  }

  /* Status-Bucket fuer das Default-Ranking.
     Niedriger Wert = hoehere Prioritaet (oben in der Tabelle). */
  function statusBucket(r) {
    const ps = (r && r.pickstatus || "").toLowerCase();
    const stations = (r && r.stationen) || [];
    const hasAnyClosed = stations.some(s => parseInt(s.status, 10) === 4);
    if (!ps || ps === "offen") return 0;                 // Offen
    if (ps === "vormontage")   return 1;
    if (ps === "montage")      return 2;
    if (ps === "verpackung")   return 3;
    if (ps === "warenausgang") return 4;
    if (ps === "montiert")     return 5;
    if (ps === "storniert")    return 6;
    // Sonstige (Stationsname als Pickstatus): wenn was geschlossen ist -> bucket 1
    return hasAnyClosed ? 1 : 0;
  }

  /* Default-Ranking nach User-Spezifikation:
     1. Status-Bucket (Offen oben, Montiert/Storniert unten)
     2. Aelteste Auftraege zuerst (alter_tage DESC)
     3. Hoechste UVP zuerst (uvp DESC)
     4. Niedrigste Montagezeit zuerst (montagezeit_min ASC) */
  function defaultRanking(rows) {
    return (rows || []).slice().sort((a, b) => {
      const ba = statusBucket(a), bb = statusBucket(b);
      if (ba !== bb) return ba - bb;
      const aa = parseInt(a.alter_tage, 10) || 0;
      const ab = parseInt(b.alter_tage, 10) || 0;
      if (aa !== ab) return ab - aa;                     // alt zuerst
      const ua = parseFloat(a.uvp) || 0;
      const ub = parseFloat(b.uvp) || 0;
      if (ua !== ub) return ub - ua;                     // teuer zuerst
      const ma = parseFloat(a.montagezeit_min) || 0;
      const mb = parseFloat(b.montagezeit_min) || 0;
      return ma - mb;                                    // schnell zuerst
    });
  }

  function markSortIndicators(tableId, key, dir) {
    document.querySelectorAll(`#${tableId} thead th`).forEach(th => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === key) th.classList.add(dir === "asc" ? "sort-asc" : "sort-desc");
    });
  }

  /* -------- Pagination -------- */
  function initPagers() {
    document.querySelectorAll(".pager").forEach(pager => {
      const tbl = pager.dataset.table;
      pager.querySelector(".page-size").addEventListener("change", (e) => {
        state.table[tbl].pageSize = parseInt(e.target.value, 10) || 50;
        state.table[tbl].page = 1;
        (tbl === "offene" ? renderOffeneTable : renderFaktTable)();
      });
      pager.querySelector(".page-prev").addEventListener("click", () => {
        if (state.table[tbl].page > 1) {
          state.table[tbl].page--;
          (tbl === "offene" ? renderOffeneTable : renderFaktTable)();
        }
      });
      pager.querySelector(".page-next").addEventListener("click", () => {
        state.table[tbl].page++;
        (tbl === "offene" ? renderOffeneTable : renderFaktTable)();
      });
    });
  }

  function paginate(rows, page, size) {
    const total  = rows.length;
    const pages  = Math.max(1, Math.ceil(total / size));
    const cur    = Math.min(Math.max(1, page), pages);
    const start  = (cur - 1) * size;
    return { rows: rows.slice(start, start + size), total, pages, page: cur };
  }

  function updatePager(tbl, info) {
    const pager = document.querySelector(`.pager[data-table="${tbl}"]`);
    if (!pager) return;
    pager.querySelector(".page-info").textContent = `${info.page} / ${info.pages}`;
    pager.querySelector(".page-prev").disabled = info.page <= 1;
    pager.querySelector(".page-next").disabled = info.page >= info.pages;
  }

  function invalidateAndReload() {
    // Tab-specific data is invalidated; daily is independent and stays.
    state.loaded.offene     = false;
    state.loaded.fakturiert = false;
    reloadCurrentTab(true);
  }

  function initSearches() {
    const so = document.getElementById("searchOffene");
    so.addEventListener("input", () => {
      searchState.offene = so.value.trim().toLowerCase();
      renderOffeneTable();
    });
    const sf = document.getElementById("searchFakt");
    sf.addEventListener("input", () => {
      searchState.fakt = sf.value.trim().toLowerCase();
      renderFaktTable();
    });
  }

  function initExports() {
    document.getElementById("exportOffene").addEventListener("click", () => {
      exportXlsx("offene-auftraege.xlsx", state.data.offene.rows, OFFENE_EXPORT_COLS, "Offene Aufträge");
    });
    document.getElementById("exportFakt").addEventListener("click", () => {
      exportXlsx("fakturierte-auftraege.xlsx", state.data.fakturiert.rows, FAKT_EXPORT_COLS, "Fakturierte Aufträge");
    });
  }

  const OFFENE_EXPORT_COLS = [
    { key: "salesid",         label: "Auftrag" },
    { key: "zeile",           label: "Zeile", type: "num" },
    { key: "datum",           label: "Datum", type: "date" },
    { key: "alter_tage",      label: "Alter (Tage)", type: "num" },
    { key: "itemid",          label: "Artikel" },
    { key: "marke",           label: "Marke" },
    { key: "modell",          label: "Modell" },
    { key: "produktgruppe",   label: "Produktgruppe" },
    { key: "fahrradtyp",      label: "Fahrradtyp" },
    { key: "menge",           label: "Menge", type: "num" },
    { key: "montagezeit_min", label: "Montagezeit (Min)", type: "num" },
    { key: "uvp",             label: "UVP (€)", type: "eur" },
    { key: "linestatus",      label: "Zeilenstatus" },
    { key: "pickstatus",      label: "Pickstatus" },
    { key: "stationen",       label: "Stationen", type: "stations" },
    { key: "lager",           label: "Lager" }
  ];

  const FAKT_EXPORT_COLS = [
    { key: "invoiceid",       label: "Rechnung" },
    { key: "salesid",         label: "Auftrag" },
    { key: "zeile",           label: "Zeile", type: "num" },
    { key: "datum",           label: "Datum", type: "date" },
    { key: "datum_montiert",  label: "Montiert am", type: "date" },
    { key: "durchlaufzeit",   label: "Durchlaufzeit (Tage)", type: "num" },
    { key: "itemid",          label: "Artikel" },
    { key: "marke",           label: "Marke" },
    { key: "modell",          label: "Modell" },
    { key: "produktgruppe",   label: "Produktgruppe" },
    { key: "fahrradtyp",      label: "Fahrradtyp" },
    { key: "menge",           label: "Menge", type: "num" },
    { key: "montagezeit_min", label: "Montagezeit (Min)", type: "num" },
    { key: "uvp",             label: "UVP (€)", type: "eur" },
    { key: "verkaufspreis",   label: "VK-Preis netto (€)", type: "eur" },
    { key: "linestatus",      label: "Zeilenstatus" },
    { key: "pickstatus",      label: "Pickstatus" },
    { key: "stationen",       label: "Stationen", type: "stations" }
  ];

  function initLogout() {
    document.getElementById("logoutBtn").addEventListener("click", () => {
      if (confirm("Wirklich abmelden?")) {
        try { clearAllCache(); } catch (_) {}
        Auth.logout();
      }
    });
  }

  function initMenuToggle() {
    const side = document.getElementById("sidebar");
    document.getElementById("menuToggle").addEventListener("click", () => {
      side.classList.toggle("open");
    });
  }

  function initRefresh() {
    document.getElementById("refreshBtn").addEventListener("click", async () => {
      // Wenn ein Snapshot existiert -> einfach neu fetchen (Timer-Triggered
      // im Backend liefert ggf. frische Daten). Sonst alte Endpoints.
      if (state.data.snapshotGeneratedAt) {
        try {
          showLoader("Daten neu laden…");
          const fresh = await API.snapshot();
          if (fresh) {
            applySnapshot(fresh);
            showSnapshotBanner(fresh);
            reRenderCurrentTab();
          }
        } catch (err) {
          toast("Aktualisierung fehlgeschlagen: " + (err.message || err), "err");
        } finally {
          hideLoader();
        }
        return;
      }
      invalidateAndReload();
      state.loaded.daily   = false;
      state.loaded.monthly = false;
      loadDaily();
      loadMonthly();
    });
  }

  /* =========================================================
     4.  LOADING
     ========================================================= */

  async function reloadCurrentTab(force = false) {
    const tab = state.tab;
    try {
      if (tab === "offene") {
        if (force || !state.loaded.offene) await loadOffene();
        else                                renderOffeneAll();
        if (!state.loaded.daily)            loadDaily(); // 30d trend powering gauge sub-info (async, non-blocking)
        // Hintergrund: Fakturiert vorausladen, damit der Tab-Wechsel sofort geht
        if (!state.loaded.fakturiert)       loadFakturiert().catch(() => {});
      }
      else if (tab === "fakturiert") {
        if (force || !state.loaded.fakturiert) await loadFakturiert();
        else                                    renderFakturiertAll();
      }
      else if (tab === "uebersicht") {
        // Übersicht braucht KEINEN eigenen API-Call. Sie aggregiert einfach
        // aus offene + fakturiert. Wenn eines davon noch nicht geladen ist
        // -> hole es kurz nach.
        if (!state.loaded.offene)     await loadOffene();
        if (!state.loaded.fakturiert) await loadFakturiert();
        renderUebersichtAll();
      }
      else if (tab === "daily") {
        if (force || !state.loaded.daily)   await loadDaily();
        else                                 renderDailyAll();
        if (force || !state.loaded.monthly) loadMonthly();
      }
    } catch (err) {
      console.error(err);
      toast(err.message || "Fehler beim Laden.", "err");
    }
  }

  async function loadOffene() {
    showLoader("Lade offene Aufträge …");
    try {
      const data = await API.offeneAuftraege(buildFilterParams());
      state.data.offene.rows = data.rows || [];
      state.data.offene.pickstatusOverview = data.pickstatusOverview || null;
      state.loaded.offene = true;
      renderOffeneAll();
      // WHS-Pickstatus per Lazy-Load nachziehen, wenn Backend leer geliefert hat
      if (data.pickstatusLazy !== false) {
        lazyLoadPickstatus("offene").catch(e => console.warn("pickstatus lazy:", e));
      }
    } finally { hideLoader(); }
  }

  async function loadFakturiert() {
    showLoader("Lade fakturierte Aufträge …");
    try {
      // Wenn der User keinen Custom-Zeitraum gesetzt hat, NUR den
      // aktuellen Monat zuerst holen (sonst wird das schnell zaeh).
      const baseFilter = buildFilterParams();
      let firstChunk;
      if (baseFilter.range === "default" || baseFilter.range === "older10") {
        firstChunk = { ...baseFilter, range: "month" };
      } else {
        firstChunk = baseFilter;
      }
      const data = await API.fakturierteAuftraege(firstChunk);
      state.data.fakturiert.rows = data.rows || [];
      state.data.fakturiert.pickstatusOverview = data.pickstatusOverview || null;
      state.loaded.fakturiert = true;
      renderFakturiertAll();
      if (data.pickstatusLazy !== false) {
        lazyLoadPickstatus("fakturiert").catch(e => console.warn("pickstatus lazy:", e));
      }
    } finally { hideLoader(); }

    // Hintergrund: aeltere Monate Stueck fuer Stueck nachladen + zusammenmerken.
    // Nur wenn der User eine "Standard"-Sicht hat (kein custom).
    if ((state.filter.range || "") === "default" || (state.filter.range || "") === "month") {
      backgroundLoadOlderFakturiert().catch(() => {});
    }
  }

  /* Laedt rueckwaerts Monate nach: aktueller Monat ist schon da,
     dann laden wir die letzten 11 Monate jeweils einzeln und
     mergen die Zeilen (nach invoiceid+itemid+zeile dedup). */
  async function backgroundLoadOlderFakturiert() {
    const today = new Date();
    const seen = new Set(
      (state.data.fakturiert.rows || []).map(r => keyForDedup(r))
    );
    for (let i = 1; i <= 11; i++) {
      const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const end   = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
      const fromIso = start.toISOString().slice(0, 10);
      const toIso   = end.toISOString().slice(0, 10);
      try {
        const data = await API.fakturierteAuftraege({
          range: "custom", from: fromIso, to: toIso,
          marke: state.filter.marke, kategorie: state.filter.kategorie
        });
        const newRows = (data.rows || []).filter(r => {
          const k = keyForDedup(r);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (newRows.length) {
          state.data.fakturiert.rows = state.data.fakturiert.rows.concat(newRows);
          if (state.tab === "fakturiert") renderFakturiertAll();
          else if (state.tab === "uebersicht") renderUebersichtAll();
        }
      } catch (_) {
        // ignorieren - das ist Best-Effort-Background
      }
    }
  }
  function keyForDedup(r) {
    return `${r.invoiceid || ""}|${r.salesid || ""}|${r.itemid || ""}|${r.zeile || ""}`;
  }

  /* Holt WHS-Pickstatus in Mini-Batches (jeweils 30 Auftraege) und merged
     sie in state.data.<which>.rows. Tabelle wird nach jedem Batch neu
     gerendert, damit der User progressiv die Badges sieht. */
  const PICK_BATCH = 30;
  const PICK_PARALLEL = 2;          // gleichzeitige Requests
  const _pickInflight = { offene: false, fakturiert: false };

  async function lazyLoadPickstatus(which) {
    if (_pickInflight[which]) return;
    _pickInflight[which] = true;
    try {
      const rowsKey = which === "offene" ? "offene" : "fakturiert";
      const rows = state.data[rowsKey].rows || [];
      // einzigartige Auftragsnummern
      const orders = Array.from(new Set(
        rows.map(r => (r.salesid || "").trim()).filter(Boolean)
      ));
      if (!orders.length) return;
      // in Batches teilen
      const batches = [];
      for (let i = 0; i < orders.length; i += PICK_BATCH) {
        batches.push(orders.slice(i, i + PICK_BATCH));
      }
      // mit kleiner Parallelitaet abarbeiten
      let idx = 0;
      async function worker() {
        while (idx < batches.length) {
          const my = batches[idx++];
          if (!my) break;
          try {
            const map = await API.pickstatusBatch(my);
            applyPickstatusMap(rowsKey, map);
            // sofort neu rendern wenn der User auf dem Tab ist
            if (state.tab === "offene"     && rowsKey === "offene")     renderOffeneAll();
            if (state.tab === "fakturiert" && rowsKey === "fakturiert") renderFakturiertAll();
            if (state.tab === "uebersicht")                              renderUebersichtAll();
          } catch (err) {
            console.warn("pickstatus batch failed:", err);
          }
        }
      }
      const workers = [];
      for (let i = 0; i < PICK_PARALLEL; i++) workers.push(worker());
      await Promise.all(workers);
    } finally {
      _pickInflight[which] = false;
    }
  }

  function applyPickstatusMap(which, map) {
    const rows = (state.data[which] && state.data[which].rows) || [];
    if (!map) return;
    rows.forEach(r => {
      const k = `${(r.salesid || "").trim()}|${(r.itemid || "").trim()}`;
      const info = map[k];
      if (info) {
        r.pickstatus = info.pickstatus || r.pickstatus || "";
        r.stationen  = Array.isArray(info.stations) ? info.stations : (r.stationen || []);
      }
    });
  }

  async function loadDaily() {
    try {
      const data = await API.dailyTracking();
      state.data.daily = data || {};
      state.loaded.daily = true;
      renderDailyAll();
    } catch (err) {
      console.error(err);
    }
  }

  async function loadMonthly() {
    try {
      const rows = await API.monthlyHistory();
      state.data.monthly = rows || [];
      state.loaded.monthly = true;
      renderMonthlyComparison();
    } catch (err) {
      console.error(err);
    }
  }

  function buildFilterParams() {
    const p = { range: state.filter.range };
    if (state.filter.range === "custom") {
      p.from = state.filter.from;
      p.to   = state.filter.to;
    }
    if (state.filter.marke)     p.marke     = state.filter.marke;
    if (state.filter.kategorie) p.kategorie = state.filter.kategorie;
    return p;
  }

  /* =========================================================
     5.  RENDER - Offene Aufträge
     ========================================================= */

  function renderOffeneAll() {
    refreshFilterDropdowns();
    renderOffeneKpis();
    renderPickstatusKpis();
    renderKategorienList();
    renderMarkenList();
    renderAeltesteList();
    renderOffeneTable();
    updateNavBadges();
    document.getElementById("filterCount").textContent =
      `${state.data.offene.rows.length} Einträge`;
  }

  /* Pickstatus-KPIs aus dem Backend-Aggregat ODER aus den Zeilen ableiten,
     falls das Backend keinen `pickstatusOverview` mitliefert. */
  function renderPickstatusKpis() {
    const rows = state.data.offene.rows || [];
    let ov = state.data.offene.pickstatusOverview;
    if (!ov) {
      // Fallback: Live aus den Zeilen aggregieren.
      ov = { offen:0, montage:0, montiert:0, verpackung:0, warenausgang:0, storniert:0 };
      rows.forEach(r => {
        const ps = (r.pickstatus || "Offen").toLowerCase();
        if (ov[ps] !== undefined) ov[ps]++;
      });
    }

    // Verpackt-KPI: zaehlt jede Zeile in der IRGENDEINE Station mit Location
    // 'Verpack...' status=4 (abgeschlossen) UND ein echtes Datum (!= 1900) hat.
    // Das funktioniert auch fuer Bikes deren Pickstatus = "Montiert" ist.
    const verpacktCount = rows.reduce((acc, r) => {
      const ok = (r.stationen || []).some(s =>
        (s.location || "").toLowerCase().startsWith("verpack") &&
        parseInt(s.status, 10) === 4 &&
        isRealDt(s.closed)
      );
      return acc + (ok ? 1 : 0);
    }, 0);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmtInt(v || 0); };
    set("kpiPsOffen",     ov.offen);
    set("kpiPsMontage",   ov.montage);
    set("kpiPsMontiert",  ov.montiert);
    set("kpiPsVerpackt",  verpacktCount);
  }

  /* SQL-Server-Default 1900-01-01 zaehlt als 'leer'. */
  function isRealDt(v) {
    if (!v) return false;
    const s = String(v);
    if (s.startsWith("1900")) return false;
    const d = new Date(v);
    return !isNaN(d.getTime()) && d.getFullYear() >= 2000;
  }

  function renderOffeneKpis() {
    const rows = state.data.offene.rows || [];
    const count = rows.reduce((s, r) => s + (parseFloat(r.menge) || 0), 0);
    const minutes = rows.reduce((s, r) => s + (parseFloat(r.montagezeit_min) || 0) * (parseFloat(r.menge) || 0), 0);
    const hours   = minutes / 60;
    const capDay  = state.settings.monteure * state.settings.stunden;
    const abbau   = capDay > 0 ? (hours / capDay) : 0;

    const elCount = document.getElementById("kpiOffeneCount");
    const elSub   = document.getElementById("kpiOffeneSub");
    const elStd   = document.getElementById("kpiOffeneStd");
    const elStdSub= document.getElementById("kpiOffeneStdSub");
    const elCap   = document.getElementById("kpiCap");
    const elAbb   = document.getElementById("kpiAbbau");

    if (elCount)  elCount.textContent  = fmtInt(count);
    if (elSub)    elSub.textContent    = `${rows.length} Positionen`;
    if (elStd)    elStd.textContent    = fmtNumber(hours, 1);
    if (elStdSub) elStdSub.textContent = `≙ ${fmtInt(minutes)} Minuten`;
    if (elCap)    elCap.textContent    = fmtNumber(capDay, 1);
    if (elAbb)    elAbb.textContent    = fmtNumber(abbau, 1);

    /* ---------- Kapazitätsauslastung Gauge ----------
       Auslastung = totale offene Arbeitsstunden / Tageskapazität × 100 %
       (d.h. wie viele Monteurtage sind offen im Verhältnis zu einem Tag) */
    const auslastung = capDay > 0 ? (hours / capDay) * 100 : 0;
    const gVal  = document.getElementById("gaugeValue");
    const gOpen = document.getElementById("gaugeOpen");
    const gCap  = document.getElementById("gaugeCap");
    const gSub  = document.getElementById("gaugeSub");
    if (gVal)  gVal.textContent  = fmtNumber(auslastung, 0) + " %";
    if (gOpen) gOpen.textContent = fmtNumber(hours, 1) + " h";
    if (gCap)  gCap.textContent  = fmtNumber(capDay, 1) + " h";
    if (gSub)  gSub.textContent  = "offene Arbeitslast vs. 1 Arbeitstag";

    if (window.Charts && document.getElementById("gaugeAuslastung")) {
      Charts.auslastungGauge("gaugeAuslastung", auslastung);
    }
  }

  function renderKategorienList() {
    const ul = document.getElementById("listKategorien");
    if (!ul) return;
    const rows = state.data.offene.rows || [];
    const map = {};
    rows.forEach(r => {
      const k = (r.fahrradtyp || r.produktgruppe || "Unbekannt");
      map[k] = (map[k] || 0) + (parseFloat(r.menge) || 0);
    });
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const total = entries.reduce((s, e) => s + e[1], 0) || 1;

    if (!entries.length) {
      ul.innerHTML = `<li class="mini-empty">Keine Daten</li>`;
      return;
    }
    ul.innerHTML = entries.map(([label, val]) => {
      const pct = (val / total) * 100;
      return `
        <li>
          <div class="mini-top">
            <span class="mini-label" title="${esc(label)}">${esc(label)}</span>
            <strong class="mini-val">${fmtInt(val)}</strong>
          </div>
          <div class="mini-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
        </li>`;
    }).join("");
  }

  function renderMarkenList() {
    const ul = document.getElementById("listMarken");
    if (!ul) return;
    const rows = state.data.offene.rows || [];
    const map = {};
    rows.forEach(r => {
      const k = (r.marke || "Unbekannt");
      map[k] = (map[k] || 0) + (parseFloat(r.menge) || 0);
    });
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const total = entries.reduce((s, e) => s + e[1], 0) || 1;

    if (!entries.length) {
      ul.innerHTML = `<li class="mini-empty">Keine Daten</li>`;
      return;
    }
    ul.innerHTML = entries.map(([label, val]) => {
      const pct = (val / total) * 100;
      return `
        <li>
          <div class="mini-top">
            <span class="mini-label" title="${esc(label)}">${esc(label)}</span>
            <strong class="mini-val">${fmtInt(val)}</strong>
          </div>
          <div class="mini-bar mini-bar-alt"><span style="width:${pct.toFixed(1)}%"></span></div>
        </li>`;
    }).join("");
  }

  function renderAeltesteList() {
    const ul = document.getElementById("listAlteste");
    if (!ul) return;
    // Nur wirklich offene Auftraege bzw. solche in der Montage anzeigen.
    // Bikes mit Pickstatus "Montiert", "Verpackung", "Warenausgang" oder
    // "Storniert" sind bereits abgearbeitet und sollen NICHT in der
    // "Aelteste offen"-Top-10 erscheinen.
    const isReallyOpen = (r) => {
      const ps = (r.pickstatus || "").toLowerCase();
      // Wenn Pickstatus leer oder "offen" oder "montage"/"vormontage" -> noch offen
      if (!ps || ps === "offen" || ps === "vormontage" || ps === "montage") return true;
      return false;
    };
    const rows = (state.data.offene.rows || [])
      .filter(isReallyOpen)
      .slice()
      .sort((a, b) => (parseInt(b.alter_tage, 10) || 0) - (parseInt(a.alter_tage, 10) || 0))
      .slice(0, 10);

    if (!rows.length) {
      ul.innerHTML = `<li class="mini-empty">Keine offenen Aufträge</li>`;
      return;
    }
    ul.innerHTML = rows.map(r => {
      const tage  = parseInt(r.alter_tage, 10) || 0;
      const tClass = tage > 30 ? "err" : tage > 10 ? "warn" : "info";
      const title = esc(`${r.marke || ""} ${r.modell || ""}`.trim() || r.itemid || "");
      return `
        <li class="age-item">
          <div class="age-left">
            <strong class="age-order">${esc(r.salesid || "")}</strong>
            <span class="age-item-name" title="${title}">${title || "&nbsp;"}</span>
          </div>
          <span class="badge ${tClass}">${fmtInt(tage)} T</span>
        </li>`;
    }).join("");
  }

  function renderOffeneTable() {
    const filtered = filterRows(state.data.offene.rows, searchState.offene);
    const s   = state.table.offene;
    const sorted = applySort(filtered, s.sortKey, s.sortDir);
    const page   = paginate(sorted, s.page, s.pageSize);
    s.page       = page.page;

    markSortIndicators("tableOffene", s.sortKey, s.sortDir);
    updatePager("offene", page);

    const body = document.querySelector("#tableOffene tbody");
    body.innerHTML = "";
    if (!page.rows.length) {
      body.innerHTML = emptyRow(13);
    } else {
      page.rows.forEach(r => body.appendChild(buildOffeneRow(r)));
    }
    document.getElementById("tableOffeneFooter").textContent =
      `${page.rows.length} angezeigt (Seite ${page.page}/${page.pages}) · ${filtered.length} gefiltert · ${state.data.offene.rows.length} gesamt`;
  }

  function buildOffeneRow(r) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(r.salesid || r.auftragsnr || "")}</strong></td>
      <td>${fmtDate(r.datum)}</td>
      <td>${esc(r.itemid || r.artikel || "")}</td>
      <td>${esc(r.marke || r.brand || "")}</td>
      <td>${esc(r.modell || r.model || "")}</td>
      <td>${esc(r.produktgruppe || "")}</td>
      <td>${esc(r.fahrradtyp || "")}</td>
      <td class="num">${fmtInt(r.menge)}</td>
      <td class="num">${fmtInt(r.montagezeit_min)} Min</td>
      <td class="num">${fmtEuro(r.uvp)}</td>
      <td>${pickstatusBadge(r.pickstatus || r.linestatus, r.stationen)}</td>
      <td class="stations-col">${stationsCell(r.stationen)}</td>
      <td>${ageBadge(r.alter_tage, r.datum)}</td>
    `;
    return tr;
  }

  function ageBadge(alterTage, date) {
    let ageDays = parseInt(alterTage, 10);
    if (!isFinite(ageDays) || ageDays < 0) {
      if (!date) return "";
      const d = new Date(date);
      ageDays = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
      if (isNaN(ageDays)) return "";
    }
    if (ageDays <= 0)   return '<span class="badge info">Heute</span>';
    if (ageDays <= 3)   return `<span class="badge info">${ageDays} T</span>`;
    if (ageDays <= 10)  return `<span class="badge warn">${ageDays} T</span>`;
    return `<span class="badge err">${ageDays} T alt</span>`;
  }

  /* D365 SalesLineStatus codes: 1=Offen/Backorder, 2=Geliefert, 3=Fakturiert, 4=Storniert */
  function statusBadge(code, label) {
    const c = parseInt(code, 10) || 0;
    const text = label || "";
    let cls = "muted";
    if (c === 1) cls = "warn";      // Offen / Backorder
    else if (c === 2) cls = "info"; // Geliefert
    else if (c === 3) cls = "ok";   // Fakturiert
    else if (c === 4) cls = "err";  // Storniert
    if (!text) return `<span class="badge ${cls}">–</span>`;
    return `<span class="badge ${cls}">${esc(text)}</span>`;
  }

  /* WHS-Pickstatus-Badge (aus WHSWarehouseWorkLineStaging berechnet) */
  /* Beim Hover wird eine Zusammenfassung aller Stationen mit Start- und
     End-Zeiten als Tooltip angezeigt. */
  function pickstatusBadge(label, stations) {
    const v = (label || "Offen").trim();
    let cls = "muted";
    const lo = v.toLowerCase();
    if (lo === "offen")              cls = "warn";
    else if (lo === "vormontage")    cls = "info";
    else if (lo === "montage")       cls = "info";
    else if (lo === "montiert")      cls = "ok";
    else if (lo === "verpackung")    cls = "ok";
    else if (lo === "warenausgang")  cls = "ok";
    else if (lo === "storniert")     cls = "err";
    const tip = stationsTooltip(stations);
    const titleAttr = tip ? ` title="${esc(tip)}"` : "";
    return `<span class="badge ${cls}"${titleAttr}>${esc(v)}</span>`;
  }

  /* Stationen-Spalte: kleine farbige Badges pro Lagerplatz/Station.
     status: 0=Offen (orange), 4=Geschlossen (grün), 5=Storniert (rot)
     Beim Hover ueber jedes Badge: Start + End-Zeit dieser Station. */
  function stationsCell(stations) {
    if (!Array.isArray(stations) || !stations.length) {
      return `<span class="muted">–</span>`;
    }
    return stations.map(s => {
      const code = parseInt(s.status, 10) || 0;
      let cls = "muted";
      if (code === 4) cls = "ok";
      else if (code === 0) cls = "warn";
      else if (code === 5) cls = "err";
      else if (code === 1) cls = "info";
      const tip = stationTooltip(s);
      return `<span class="badge ${cls} station-badge" title="${esc(tip)}">${esc(s.location || "")}</span>`;
    }).join(" ");
  }

  /* Tooltip-Text fuer EINE Station */
  function stationTooltip(s) {
    if (!s) return "";
    const lines = [];
    const loc = (s.location || "").trim();
    if (loc) lines.push(loc);
    lines.push("Status: " + lineStatusText(s.status));
    const started = s.started ? fmtDateTime(s.started) : "";
    const closed  = s.closed  ? fmtDateTime(s.closed)  : "";
    if (started) lines.push("Start: " + started);
    if (closed)  lines.push("Ende:  " + closed);
    else if (started && parseInt(s.status, 10) !== 4) lines.push("Ende:  – (laeuft noch)");
    return lines.join("\n");
  }

  /* Tooltip-Text fuer den GESAMTEN Pickstatus-Badge (alle Stationen) */
  function stationsTooltip(stations) {
    if (!Array.isArray(stations) || !stations.length) return "";
    // chronologisch aufsteigend (frueheste zuerst)
    const sorted = stations.slice().sort((a, b) => {
      const ta = new Date(a.closed || a.started || 0).getTime();
      const tb = new Date(b.closed || b.started || 0).getTime();
      return ta - tb;
    });
    return sorted.map(s => {
      const loc = (s.location || "").trim() || "?";
      const started = s.started ? fmtDateTime(s.started) : "–";
      const closed  = s.closed  ? fmtDateTime(s.closed)  : "laeuft";
      return `${loc}: ${started}  ->  ${closed}`;
    }).join("\n");
  }

  /* =========================================================
     6.  RENDER - Fakturierte Aufträge
     ========================================================= */

  function renderFakturiertAll() {
    refreshFilterDropdowns();
    renderFaktKpis();
    renderFaktCharts();
    renderFaktTable();
    updateNavBadges();
    document.getElementById("filterCount").textContent =
      `${state.data.fakturiert.rows.length} Einträge`;
  }

  function renderFaktKpis() {
    const rows = state.data.fakturiert.rows || [];
    const count = rows.reduce((s, r) => s + (parseFloat(r.menge) || 0), 0);
    const minutes = rows.reduce((s, r) =>
      s + (parseFloat(r.montagezeit_min) || 0) * (parseFloat(r.menge) || 0), 0);
    const hours = minutes / 60;
    const avg = count > 0 ? minutes / count : 0;
    const umsatz = rows.reduce((s, r) => s + (parseFloat(r.uvp) || 0) * (parseFloat(r.menge) || 0), 0);

    document.getElementById("kpiFaktCount").textContent  = fmtInt(count);
    document.getElementById("kpiFaktStd").textContent    = fmtNumber(hours, 1);
    document.getElementById("kpiFaktAvg").textContent    = fmtNumber(avg, 0);
    document.getElementById("kpiFaktUmsatz").textContent = fmtEuro(umsatz);
  }

  function renderFaktCharts() {
    const rows = state.data.fakturiert.rows || [];

    // Per day
    const byDay = {};
    rows.forEach(r => {
      const d = (r.datum || "").slice(0, 10);
      if (!d) return;
      byDay[d] = (byDay[d] || 0) + (parseFloat(r.menge) || 0);
    });
    const sortedDays = Object.keys(byDay).sort();
    if (window.Charts) Charts.faktDaily("chartFaktDaily",
      sortedDays.map(d => fmtDate(d)),
      sortedDays.map(d => byDay[d]));

    // Top brands
    const byBrand = {};
    rows.forEach(r => {
      const b = r.marke || "Unbekannt";
      byBrand[b] = (byBrand[b] || 0) + (parseFloat(r.menge) || 0);
    });
    const top = Object.entries(byBrand).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (window.Charts) Charts.topBrands("chartFaktBrands",
      top.map(e => e[0]),
      top.map(e => e[1]));
  }

  function renderFaktTable() {
    const filtered = filterRows(state.data.fakturiert.rows, searchState.fakt);
    const s   = state.table.fakt;
    const sorted = applySort(filtered, s.sortKey, s.sortDir);
    const page   = paginate(sorted, s.page, s.pageSize);
    s.page       = page.page;

    markSortIndicators("tableFakt", s.sortKey, s.sortDir);
    updatePager("fakt", page);

    const body = document.querySelector("#tableFakt tbody");
    body.innerHTML = "";
    if (!page.rows.length) {
      body.innerHTML = emptyRow(12);
    } else {
      page.rows.forEach(r => body.appendChild(buildFaktRow(r)));
    }
    document.getElementById("tableFaktFooter").textContent =
      `${page.rows.length} angezeigt (Seite ${page.page}/${page.pages}) · ${filtered.length} gefiltert · ${state.data.fakturiert.rows.length} gesamt`;
  }

  function buildFaktRow(r) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(r.invoiceid || r.rechnungsnr || "")}</strong></td>
      <td>${fmtDate(r.datum)}</td>
      <td>${esc(r.itemid || "")}</td>
      <td>${esc(r.marke || "")}</td>
      <td>${esc(r.modell || "")}</td>
      <td>${esc(r.produktgruppe || "")}</td>
      <td>${esc(r.fahrradtyp || "")}</td>
      <td class="num">${fmtInt(r.menge)}</td>
      <td class="num">${fmtInt(r.montagezeit_min)} Min</td>
      <td class="num">${fmtEuro(r.uvp)}</td>
      <td>${pickstatusBadge(r.pickstatus || r.linestatus, r.stationen)}</td>
      <td class="stations-col">${stationsCell(r.stationen)}</td>
    `;
    return tr;
  }

  /* =========================================================
     7.  RENDER - Daily Tracking
     ========================================================= */

  function renderDailyAll() {
    renderDailyKpis();
    renderDailyCharts();
    renderDailyTable();
    renderMonthlyComparison();
  }

  function renderMonthlyComparison() {
    const rows = state.data.monthly || [];
    if (!rows.length || !window.Charts) return;

    const now = new Date();
    const curYear  = now.getFullYear();
    const prevYear = curYear - 1;

    const MONAT_LABELS = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
    const curValues  = new Array(12).fill(0);
    const prevValues = new Array(12).fill(0);

    rows.forEach(r => {
      const m = (r.monat || 0) - 1;
      if (m < 0 || m > 11) return;
      if (r.jahr === curYear)  curValues[m]  = r.raeder;
      if (r.jahr === prevYear) prevValues[m] = r.raeder;
    });

    Charts.monthlyComparison("chartMonthly",
      MONAT_LABELS, curValues, prevValues, curYear, prevYear);
  }

  function renderDailyKpis() {
    const d = state.data.daily || {};
    const trend   = d.trend_30d || [];
    const today   = new Date().toISOString().slice(0, 10);
    const todayRow = trend.find(t => t.datum === today) || {};
    const totalBikes = trend.reduce((s, t) => s + (parseInt(t.raeder, 10) || 0), 0);
    const workdays = Math.max(1, trend.filter(t => {
      const dt = new Date(t.datum + "T00:00:00");
      return state.settings.workdays.includes(dt.getDay());
    }).length);
    const avg = totalBikes / workdays;
    let peak = { raeder: 0, datum: "–" };
    trend.forEach(t => { if ((t.raeder || 0) > peak.raeder) peak = t; });

    document.getElementById("kpiHeuteMontiert").textContent = fmtInt(todayRow.raeder || 0);
    document.getElementById("kpiAvg30").textContent         = fmtNumber(avg, 1);
    document.getElementById("kpiPeak").textContent          = fmtInt(peak.raeder || 0);
    document.getElementById("kpiPeakDate").textContent      = peak.datum ? fmtDate(peak.datum) : "–";
    document.getElementById("kpiBacklog").textContent       = fmtInt(d.offene_anzahl || 0);
  }

  function renderDailyCharts() {
    const d = state.data.daily || {};
    const trend = d.trend_30d || [];

    if (window.Charts) Charts.tracking30d("chart30d",
      trend.map(t => fmtDate(t.datum)),
      trend.map(t => t.raeder || 0));

    // Bike type distribution: prefer server value, else compute from offene rows
    let byType = d.offene_by_type || [];
    if (!byType.length) {
      const counts = {};
      (state.data.offene.rows || []).forEach(r => {
        const t = r.fahrradtyp || "Unbekannt";
        counts[t] = (counts[t] || 0) + (parseFloat(r.menge) || 0);
      });
      byType = Object.entries(counts).map(([fahrradtyp, anzahl]) => ({ fahrradtyp, anzahl }));
    }
    if (window.Charts) Charts.donutBikeType("donutBikeType",
      byType.map(t => t.fahrradtyp || "Unbekannt"),
      byType.map(t => t.anzahl || 0));
  }

  function renderDailyTable() {
    const trend = (state.data.daily && state.data.daily.trend_30d) || [];
    const body  = document.querySelector("#tableDaily tbody");
    body.innerHTML = "";
    if (!trend.length) {
      body.innerHTML = emptyRow(7);
      return;
    }
    const capDay = state.settings.monteure * state.settings.stunden;

    // If backend did not provide per-day minutes, fall back to 30 Min/Rad baseline
    const avgMinPerRad = computeAvgMinutesPerRad();

    trend.slice().reverse().forEach(t => {
      const dt = new Date(t.datum + "T00:00:00");
      const wd = dt.toLocaleDateString(APP_CONFIG.LOCALE, { weekday: "long" });
      const min = parseFloat(t.minutes) || ((parseFloat(t.raeder) || 0) * avgMinPerRad);
      const hours = min / 60;
      const avg = (t.raeder > 0) ? (min / t.raeder) : 0;
      const aus = capDay > 0 ? (hours / capDay) * 100 : 0;
      const ausCls = aus < 70 ? "num-pos" : aus > 105 ? "num-neg" : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDate(t.datum)}</td>
        <td>${wd}</td>
        <td class="num">${fmtInt(t.raeder)}</td>
        <td class="num">${fmtNumber(hours, 1)} Std</td>
        <td class="num">${fmtInt(avg)} Min</td>
        <td class="num">${fmtNumber(capDay, 1)} Std</td>
        <td class="num ${ausCls}">${fmtNumber(aus, 0)} %</td>
      `;
      body.appendChild(tr);
    });
  }

  /* =========================================================
     7b. RENDER - Montage-Übersicht (pro Artikelnummer)
     ========================================================= */

  // Cache des letzten Aggregats, damit Sort/Pager nicht alles neu rechnen muessen.
  let _ubAggregate = null;
  let _ubSearch = "";

  function renderUebersichtAll() {
    refreshFilterDropdowns();
    _ubAggregate = aggregateByArticle(
      state.data.offene.rows || [],
      state.data.fakturiert.rows || []
    );
    renderUbKpis();
    renderUbCharts();
    renderUbTable();
  }

  /* Aggregiert offene + fakturierte Auftragszeilen pro ITEMID (Artikelnummer). */
  function aggregateByArticle(offene, fakt) {
    const m = new Map();
    const get = (id) => {
      let g = m.get(id);
      if (!g) {
        g = {
          itemid: id,
          marke: "",
          modell: "",
          fahrradtyp: "",
          produktgruppe: "",
          uvp: 0,
          montagezeit_min: 0,
          // Mengen
          menge_offen: 0,
          menge_fakt:  0,
          // Counts (Anzahl Auftragszeilen, nicht Stueck)
          cnt_offen: 0,           // noch nicht montiert (offen UND keine Montage closed)
          cnt_in_montage: 0,      // Pickstatus = montage
          cnt_montiert: 0,        // Pickstatus = montiert
          cnt_storniert: 0,
          cnt_fakt: 0,
          // Termine
          alter_max: 0,
          datum_letzte: null,
          // Detailliste
          rows_offen: [],
          rows_fakt:  []
        };
        m.set(id, g);
      }
      return g;
    };

    (offene || []).forEach(r => {
      const id = r.itemid || "";
      if (!id) return;
      const g = get(id);
      g.marke         = g.marke         || r.marke || "";
      g.modell        = g.modell        || r.modell || "";
      g.fahrradtyp    = g.fahrradtyp    || r.fahrradtyp || "";
      g.produktgruppe = g.produktgruppe || r.produktgruppe || "";
      if (parseFloat(r.uvp) > g.uvp) g.uvp = parseFloat(r.uvp) || 0;
      if (parseFloat(r.montagezeit_min) > g.montagezeit_min) g.montagezeit_min = parseFloat(r.montagezeit_min) || 0;
      const qty = parseFloat(r.menge) || 0;
      g.menge_offen += qty;
      const ps = (r.pickstatus || "offen").toLowerCase();
      if (ps === "montiert")        g.cnt_montiert++;
      else if (ps === "storniert")  g.cnt_storniert++;
      else if (ps === "montage" || ps === "vormontage" || ps === "verpackung" || ps === "warenausgang")
                                    g.cnt_in_montage++;
      else                          g.cnt_offen++;
      const at = parseInt(r.alter_tage, 10) || 0;
      if (at > g.alter_max) g.alter_max = at;
      if (r.datum) {
        const d = new Date(r.datum);
        if (!isNaN(d) && (!g.datum_letzte || d > g.datum_letzte)) g.datum_letzte = d;
      }
      g.rows_offen.push(r);
    });

    (fakt || []).forEach(r => {
      const id = r.itemid || "";
      if (!id) return;
      const g = get(id);
      g.marke         = g.marke         || r.marke || "";
      g.modell        = g.modell        || r.modell || "";
      g.fahrradtyp    = g.fahrradtyp    || r.fahrradtyp || "";
      g.produktgruppe = g.produktgruppe || r.produktgruppe || "";
      if (parseFloat(r.uvp) > g.uvp) g.uvp = parseFloat(r.uvp) || 0;
      const qty = parseFloat(r.menge) || 0;
      g.menge_fakt += qty;
      g.cnt_fakt++;
      if (r.datum) {
        const d = new Date(r.datum);
        if (!isNaN(d) && (!g.datum_letzte || d > g.datum_letzte)) g.datum_letzte = d;
      }
      g.rows_fakt.push(r);
    });

    return Array.from(m.values());
  }

  function renderUbKpis() {
    const arr = _ubAggregate || [];
    document.getElementById("kpiUbArtikel").textContent = fmtInt(arr.length);
    let totOffen = 0, totFakt = 0;
    arr.forEach(g => { totOffen += g.menge_offen; totFakt += g.menge_fakt; });
    document.getElementById("kpiUbOffenStk").textContent = fmtInt(totOffen);
    document.getElementById("kpiUbFaktStk").textContent  = fmtInt(totFakt);

    // Ø Montagezeit (real) = Median Δ zwischen 1. und 2. Montage-Close
    // ueber alle offenen/fakturierten Zeilen mit >=2 Montage-Closes.
    const deltas = [];
    [...(state.data.offene.rows || []), ...(state.data.fakturiert.rows || [])].forEach(r => {
      const closes = (r.stationen || [])
        .filter(s => (s.location || "").toLowerCase() === "montage" && parseInt(s.status, 10) === 4)
        .map(s => s.closed ? new Date(s.closed) : null)
        .filter(d => d && !isNaN(d.getTime()))
        .sort((a, b) => a - b);
      if (closes.length >= 2) {
        const diffMin = (closes[1] - closes[0]) / 60000;
        if (diffMin > 0 && diffMin < 24 * 60) deltas.push(diffMin);   // Plausibilitaet: <24h
      }
    });
    const el = document.getElementById("kpiUbAvgMon");
    if (deltas.length) {
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      el.textContent = fmtNumber(median, 0);
    } else {
      el.textContent = "–";
    }
  }

  function renderUbCharts() {
    const arr = _ubAggregate || [];
    // Top 10 Artikel nach fakturierter Menge
    const top = arr.slice().sort((a, b) => b.menge_fakt - a.menge_fakt).slice(0, 10);
    if (window.Charts && Charts.topBrands) {
      Charts.topBrands(
        "chartTopSelled",
        top.map(g => `${g.itemid} · ${(g.modell || "").slice(0, 20)}`),
        top.map(g => g.menge_fakt)
      );
    }

    // Donut: Verteilung Status (Mengen, nicht Counts)
    let off = 0, mont = 0, fertig = 0, fakt = 0;
    arr.forEach(g => {
      // sehr grob: cnt_offen ~ Anteil offen, cnt_in_montage ~ in Montage, cnt_montiert ~ fertig
      // Mengen hier mal grob ueber count-Verhaeltnis schaetzen, einfacher: rohe Counts
      off    += g.cnt_offen;
      mont   += g.cnt_in_montage;
      fertig += g.cnt_montiert;
      fakt   += g.cnt_fakt;
    });
    if (window.Charts && Charts.bikeTypeDonut) {
      Charts.bikeTypeDonut(
        "donutUbStatus",
        ["Offen", "In Montage", "Montiert", "Fakturiert"],
        [off, mont, fertig, fakt]
      );
    }
  }

  function filterUbRows(rows) {
    const q = _ubSearch;
    if (!q) return rows;
    return rows.filter(g =>
      (g.itemid || "").toLowerCase().includes(q) ||
      (g.marke  || "").toLowerCase().includes(q) ||
      (g.modell || "").toLowerCase().includes(q) ||
      (g.fahrradtyp || "").toLowerCase().includes(q)
    );
  }

  function renderUbTable() {
    const s = state.table.uebersicht;
    const filtered = filterUbRows(_ubAggregate || []);
    const sortKey = s.sortKey || "menge_offen";
    const factor = s.sortDir === "asc" ? 1 : -1;
    const sorted = filtered.slice().sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb) && typeof va !== "string") return (na - nb) * factor;
      if (va instanceof Date || vb instanceof Date) {
        return ((va ? va.getTime() : 0) - (vb ? vb.getTime() : 0)) * factor;
      }
      return String(va || "").localeCompare(String(vb || ""), APP_CONFIG.LOCALE, { numeric: true }) * factor;
    });
    const page = paginate(sorted, s.page, s.pageSize);
    s.page = page.page;
    markSortIndicators("tableUebersicht", s.sortKey, s.sortDir);
    updatePager("uebersicht", page);

    const body = document.querySelector("#tableUebersicht tbody");
    body.innerHTML = "";
    if (!page.rows.length) {
      body.innerHTML = emptyRow(13);
    } else {
      page.rows.forEach(g => body.appendChild(buildUbRow(g)));
    }
    document.getElementById("tableUbFooter").textContent =
      `${page.rows.length} Artikel angezeigt (Seite ${page.page}/${page.pages}) · ${filtered.length} gefiltert · ${(_ubAggregate || []).length} gesamt`;
  }

  function buildUbRow(g) {
    const tr = document.createElement("tr");
    const ageBadgeHtml = g.alter_max > 0
      ? ageBadge(g.alter_max, null)
      : '<span class="muted">–</span>';
    tr.innerHTML = `
      <td><strong>${esc(g.itemid)}</strong></td>
      <td>${esc(g.marke)}</td>
      <td>${esc(g.modell)}</td>
      <td>${esc(g.fahrradtyp)}</td>
      <td class="num">${fmtEuro(g.uvp)}</td>
      <td class="num">${fmtInt(g.menge_offen)}</td>
      <td class="num">${fmtInt(g.menge_fakt)}</td>
      <td class="num">${fmtInt(g.cnt_montiert)}</td>
      <td class="num">${fmtInt(g.cnt_in_montage)}</td>
      <td class="num">${fmtInt(g.cnt_offen)}</td>
      <td class="num">${ageBadgeHtml}</td>
      <td>${g.datum_letzte ? fmtDate(g.datum_letzte) : "–"}</td>
      <td class="num">
        <button class="icon-btn ub-eye" data-itemid="${esc(g.itemid)}" title="Details anzeigen">
          <svg viewBox="0 0 24 24"><path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
        </button>
      </td>
    `;
    tr.querySelector(".ub-eye").addEventListener("click", () => openUbDrawer(g.itemid));
    return tr;
  }

  function openUbDrawer(itemid) {
    const g = (_ubAggregate || []).find(x => x.itemid === itemid);
    if (!g) return;
    document.getElementById("ubDrawerTitle").textContent = `${itemid} · ${g.marke || ""} ${g.modell || ""}`.trim();
    document.getElementById("ubDrawerSub").textContent =
      `${g.fahrradtyp || ""} · UVP ${fmtEuro(g.uvp)} · Montage ${fmtInt(g.montagezeit_min)} Min`;

    const body = document.getElementById("ubDrawerBody");
    const renderList = (label, rows, isOffen) => {
      if (!rows.length) return `<h4>${esc(label)} <span class="muted">(0)</span></h4>`;
      const trows = rows.map(r => `
        <tr>
          <td><strong>${esc(r.salesid || r.invoiceid || "")}</strong></td>
          <td>${fmtDate(r.datum)}</td>
          <td class="num">${fmtInt(r.menge)}</td>
          <td>${pickstatusBadge(r.pickstatus || "Offen", r.stationen)}</td>
          <td class="stations-col">${stationsCell(r.stationen)}</td>
          ${isOffen ? `<td>${ageBadge(r.alter_tage, r.datum)}</td>` : `<td>–</td>`}
        </tr>`).join("");
      return `
        <h4>${esc(label)} <span class="muted">(${rows.length})</span></h4>
        <div class="table-wrap"><table class="data-table compact">
          <thead><tr><th>${isOffen ? "Auftrag" : "Rechnung"}</th><th>Datum</th><th class="num">Menge</th><th>Status</th><th>Stationen</th><th>${isOffen ? "Alter" : "–"}</th></tr></thead>
          <tbody>${trows}</tbody>
        </table></div>`;
    };
    body.innerHTML =
      renderList("Offene Aufträge", g.rows_offen, true) +
      renderList("Fakturierte Aufträge", g.rows_fakt, false);

    document.getElementById("ubDrawer").classList.remove("hidden");
  }
  function closeUbDrawer() {
    document.getElementById("ubDrawer").classList.add("hidden");
  }

  /* =========================================================
     8.  SIDEBAR BADGES
     ========================================================= */

  function updateNavBadges() {
    const o = document.getElementById("navBadgeOffene");
    const f = document.getElementById("navBadgeFakt");
    if (o) o.textContent = fmtInt(
      (state.data.offene.rows || []).reduce((s, r) => s + (parseFloat(r.menge) || 0), 0));
    if (f) f.textContent = fmtInt(
      (state.data.fakturiert.rows || []).reduce((s, r) => s + (parseFloat(r.menge) || 0), 0));
  }

  /* =========================================================
     9.  LOADER / TOAST
     ========================================================= */

  function showLoader(text) {
    document.getElementById("loadingText").textContent = text || "Lade Daten…";
    document.getElementById("loadingOverlay").classList.add("show");
  }
  function hideLoader() {
    document.getElementById("loadingOverlay").classList.remove("show");
  }

  function toast(msg, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.innerHTML = `<div><strong>${type === "err" ? "Fehler" : type === "warn" ? "Hinweis" : type === "ok" ? "Erfolg" : "Info"}</strong><span>${esc(msg)}</span></div>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }

  /* =========================================================
     10.  UTILS
     ========================================================= */

  function filterRows(rows, query) {
    let out = rows || [];

    // 1. Volltext-Suche
    if (query) {
      out = out.filter(r =>
        (r.salesid || r.invoiceid || "").toLowerCase().includes(query) ||
        (r.itemid || "").toLowerCase().includes(query) ||
        (r.marke || "").toLowerCase().includes(query) ||
        (r.modell || "").toLowerCase().includes(query) ||
        (r.produktgruppe || "").toLowerCase().includes(query) ||
        (r.fahrradtyp || "").toLowerCase().includes(query) ||
        (r.linestatus || "").toLowerCase().includes(query) ||
        (r.pickstatus || "").toLowerCase().includes(query) ||
        ((r.stationen || []).map(s => (s.location || "")).join(" ")
          .toLowerCase().includes(query))
      );
    }

    // 2. Pickstatus-Dropdown
    const pf = (state.filter.pickstatus || "").toLowerCase();
    if (pf) {
      out = out.filter(r => (r.pickstatus || "").toLowerCase() === pf);
    }

    // 3. Lagerplatz: irgendeine Station hat diesen Code
    const lp = (state.filter.lagerplatz || "").toLowerCase();
    if (lp) {
      out = out.filter(r =>
        (r.stationen || []).some(s => (s.location || "").toLowerCase() === lp)
      );
    }

    // 4. Montage abgeschlossen / nicht abgeschlossen
    if (state.filter.montiertOnly === true) {
      out = out.filter(r => hasStationClosed(r, "montage"));
    } else if (state.filter.montiertOnly === false) {
      out = out.filter(r => !hasStationClosed(r, "montage"));
    }

    // 5. Verpackung abgeschlossen / nicht abgeschlossen
    if (state.filter.verpacktOnly === true) {
      out = out.filter(r => hasStationClosedPrefix(r, "verpack"));
    } else if (state.filter.verpacktOnly === false) {
      out = out.filter(r => !hasStationClosedPrefix(r, "verpack"));
    }

    return out;
  }

  function hasStationClosed(r, name) {
    const lo = String(name).toLowerCase();
    return (r.stationen || []).some(s =>
      (s.location || "").toLowerCase() === lo &&
      parseInt(s.status, 10) === 4
    );
  }
  function hasStationClosedPrefix(r, prefix) {
    const lo = String(prefix).toLowerCase();
    return (r.stationen || []).some(s =>
      (s.location || "").toLowerCase().startsWith(lo) &&
      parseInt(s.status, 10) === 4
    );
  }

  function emptyRow(cols) {
    return `<tr><td colspan="${cols}">
      <div class="empty">
        <svg viewBox="0 0 24 24"><path d="M21 5v14H3V5zM5 7v10h14V7zm2 2h6v2H7zm0 4h10v2H7z"/></svg>
        <strong>Keine Daten</strong>
        <span>Für den aktuellen Filter gibt es keine Einträge.</span>
      </div>
    </td></tr>`;
  }

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/[&<>\"']/g,
      ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }

  function fmtInt(v) {
    const n = parseFloat(v);
    if (!isFinite(n)) return "0";
    return Math.round(n).toLocaleString(APP_CONFIG.LOCALE);
  }
  function fmtNumber(v, digits = 1) {
    const n = parseFloat(v);
    if (!isFinite(n)) return (0).toFixed(digits);
    return n.toLocaleString(APP_CONFIG.LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtEuro(v) {
    const n = parseFloat(v);
    if (!isFinite(n)) return "–";
    return n.toLocaleString(APP_CONFIG.LOCALE, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  }
  function fmtDate(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v).slice(0, 10);
    return d.toLocaleDateString(APP_CONFIG.LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  function fmtDateTime(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(APP_CONFIG.LOCALE, {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }
  /* Status-Code -> menschen-lesbar fuer Tooltips */
  function lineStatusText(code) {
    const c = parseInt(code, 10);
    if (c === 4) return "Abgeschlossen";
    if (c === 0) return "Offen";
    if (c === 5) return "Storniert";
    if (c === 1) return "In Arbeit";
    return "–";
  }

  function computeAvgMinutesPerRad() {
    // Prefer a weighted average from the Aufbauzeiten lookup across open rows
    const rows = state.data.offene.rows || [];
    if (rows.length) {
      let totalMin = 0, totalMng = 0;
      rows.forEach(r => {
        const qty = parseFloat(r.menge) || 0;
        const min = parseFloat(r.montagezeit_min) || 0;
        totalMin += min * qty;
        totalMng += qty;
      });
      if (totalMng > 0) return totalMin / totalMng;
    }
    return 30;   // sensible default
  }

  /**
   * Export given rows to an .xlsx file using SheetJS (loaded via CDN).
   * Falls back to CSV if SheetJS is unavailable.
   */
  function exportXlsx(filename, rows, cols, sheetName) {
    if (!rows || !rows.length) {
      toast("Keine Daten zum Export.", "warn");
      return;
    }

    // Build array of arrays (header + rows)
    const header = cols.map(c => c.label);
    const body = rows.map(r => cols.map(c => {
      const v = r[c.key];
      if (v === null || v === undefined) return "";
      if (c.type === "num")  return parseFloat(v) || 0;
      if (c.type === "eur")  return parseFloat(v) || 0;
      if (c.type === "date") {
        const d = new Date(v);
        return isNaN(d.getTime()) ? v : d;
      }
      if (c.type === "stations") {
        // "Montage(4); Verpackung(0); Warenausgang(4)"
        if (!Array.isArray(v)) return "";
        return v.map(s =>
          (s.location || "") + "(" + (s.status === undefined ? "" : s.status) + ")"
        ).join("; ");
      }
      return String(v);
    }));

    // Sum row for numeric columns (Menge + Montagezeit)
    const sumRow = cols.map(c => {
      if (c.key === "menge" || c.key === "montagezeit_min") {
        return rows.reduce((s, r) => s + (parseFloat(r[c.key]) || 0), 0);
      }
      if (c.key === "uvp") {
        return rows.reduce((s, r) => s + (parseFloat(r.uvp) || 0) * (parseFloat(r.menge) || 0), 0);
      }
      return "";
    });
    sumRow[0] = "Σ Summe";

    const aoa = [header, ...body, [], sumRow];

    if (typeof XLSX === "undefined") {
      // Fallback to CSV
      const sep  = ";";
      const fmt = (v) => {
        const s = (v === null || v === undefined) ? ""
                : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
        return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = aoa.map(r => r.map(fmt).join(sep)).join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename.replace(/\.xlsx$/i, ".csv");
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

    // Auto column widths
    ws["!cols"] = cols.map((c, i) => {
      let max = header[i].length;
      body.forEach(r => { const v = r[i] == null ? "" : String(r[i]); if (v.length > max) max = v.length; });
      return { wch: Math.min(Math.max(max + 2, 10), 40) };
    });

    // Number formats
    const nRows = aoa.length, nCols = cols.length;
    for (let r = 1; r < nRows; r++) {
      for (let c = 0; c < nCols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr]; if (!cell) continue;
        const type = cols[c].type;
        if (type === "eur") cell.z = '#,##0.00 "€"';
        else if (type === "num")  cell.z = "#,##0";
        else if (type === "date") cell.z = "dd.mm.yyyy";
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || "Daten").slice(0, 31));

    // Meta
    wb.Props = {
      Title:   "Fahrrad XXL Montage Export",
      Subject: sheetName || "Export",
      Author:  "Montage Dashboard",
      CreatedDate: new Date()
    };

    XLSX.writeFile(wb, filename, { compression: true });
    toast(`${rows.length} Zeilen exportiert.`, "ok");
  }

})();
