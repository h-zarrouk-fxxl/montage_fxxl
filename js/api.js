/* =============================================================
   Fahrrad XXL - Montage Dashboard
   API client - wraps fetch() calls to the Vercel backend.
   Also normalizes the backend's PascalCase payload into the
   lowercase "canonical" keys used throughout app.js.
   ============================================================= */

(function () {
  const BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "/api";

  /* ---------- Low-level fetch helpers ---------- */

  function buildUrl(path, params) {
    const url = new URL(path.startsWith("http") ? path : BASE + path, window.location.href);
    if (params) {
      Object.keys(params).forEach(k => {
        const v = params[k];
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.append(k, v);
        }
      });
    }
    return url.toString();
  }

  async function request(method, path, { params, body, noAuth } = {}) {
    const headers = { "Accept": "application/json" };
    let bodyPayload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyPayload = JSON.stringify(body);
    }
    if (!noAuth) {
      const tok = localStorage.getItem(APP_CONFIG.TOKEN_KEY);
      if (tok) headers["Authorization"] = "Bearer " + tok;
    }
    const url = buildUrl(path, params);
    let res;
    try {
      res = await fetch(url, { method, headers, body: bodyPayload, mode: "cors" });
    } catch (err) {
      // Reine Netz-/Abort-Fehler NICHT als Session-Ende behandeln –
      // das würde beim Tab-Wechsel einen Fake-Logout auslösen.
      const aborted = (err && (err.name === "AbortError" || String(err).includes("abort")));
      throw new ApiError(0, aborted ? "Anfrage abgebrochen." : "Verbindung zum Server fehlgeschlagen.", err);
    }
    // NUR bei echtem 401 ausloggen – nicht bei 0 / 5xx / Netzwerkfehler.
    if (res.status === 401 && !noAuth) {
      localStorage.removeItem(APP_CONFIG.TOKEN_KEY);
      localStorage.removeItem(APP_CONFIG.USER_KEY);
      if (!location.pathname.endsWith("login.html")) location.replace("login.html");
      throw new ApiError(401, "Sitzung abgelaufen. Bitte erneut anmelden.");
    }
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { data = await res.json(); } catch (_) {}
    } else {
      try { data = await res.text(); } catch (_) {}
    }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error
                : (typeof data === "string" && data) ? data
                : `Request failed (${res.status})`;
      throw new ApiError(res.status, msg, data);
    }
    return data;
  }

  class ApiError extends Error {
    constructor(status, message, payload) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  }

  /* ---------- Normalization: backend PascalCase -> canonical lowercase ---------- */

  function normRow(r) {
    // Pick first defined
    const pick = (...keys) => {
      for (const k of keys) {
        if (r[k] !== undefined && r[k] !== null) return r[k];
      }
      return undefined;
    };
    return {
      // IDs
      salesid:       pick("Auftragsnummer", "SalesOrderNumber", "salesid"),
      invoiceid:     pick("Rechnungsnummer", "INVOICENUMBER", "invoiceid"),
      itemid:        pick("XNummer", "ItemNumber", "ITEMID", "itemid"),
      zeile:         pick("Zeilennummer", "LineNumber"),

      // Dates
      datum:         pick("Auftragsdatum", "Fakturierungsdatum", "DatumMontiert", "datum"),
      datum_faktur:  pick("Fakturierungsdatum"),
      datum_montiert:pick("DatumMontiert"),

      // Customer (backend doesn't currently return customer name - keep blank)
      kunde:         pick("Kunde", "KUNDE", "CUSTOMERNAME", "kunde") || "",

      // Product
      marke:         pick("Marke", "BRANDNAME", "marke"),
      modell:        pick("Modellname", "MODELNAME", "modell"),
      produktgruppe: pick("Produktgruppe", "PRODUCTGROUPNAME", "produktgruppe"),
      produktgruppencode: pick("ProduktgruppenCode"),
      fahrradtyp:    pick("Fahrradtyp", "fahrradtyp"),
      kategorie:     pick("KategorieName"),

      // Quantities / prices
      menge:            parseFloat(pick("Menge", "menge") || 0) || 0,
      montagezeit_min:  parseFloat(pick("MontagezeitMin", "montagezeit_min") || 0) || 0,
      uvp:              parseFloat(pick("UVP", "SalesPrice", "uvp") || 0) || 0,
      verkaufspreis:    parseFloat(pick("VerkaufspreisNetto") || 0) || 0,

      alter_tage:       parseInt(pick("AlterTage") || 0, 10) || 0,
      durchlaufzeit:    parseInt(pick("DurchlaufzeitTage") || 0, 10) || 0,

      // Line status per Artikel
      linestatus:       pick("LineStatus") || "",
      linestatuscode:   parseInt(pick("LineStatusCode") || 0, 10) || 0,

      // WHS-Pickstatus (Vormontage / Montage / Montiert / Verpackung /
      // Warenausgang / Storniert / Offen) + Stationen-Liste pro Bike
      pickstatus:       pick("Pickstatus") || "",
      stationen:        Array.isArray(r.Stationen) ? r.Stationen
                       : (Array.isArray(r.stationen) ? r.stationen : []),

      lager:            pick("Lager", "Warehouse"),

      // -- Zahlung / Leasing (aus SalesOrderHeader) --
      zahlungsart:      pick("Zahlungsart", "CUSTOMERPAYMENTMETHODNAME") || "",
      ist_leasing:      parseInt(pick("IstLeasing") || 0, 10) === 1,

      // -- Bike-Stammdaten (aus FXXLBikeTransStaging via ITEMID/XNummer) --
      licenseplate:     (pick("LicensePlate") || "").toString().trim(),
      framenumber:      (pick("FrameNumber") || "").toString().trim(),
      bikestatus:       pick("BikeStatus"),
      bikeworkstatus:   pick("BikeWorkStatus"),
      complexity:       (function(){ const v = pick("Complexity"); return (v===null||v===undefined) ? null : parseInt(v,10); })(),
      bike_minutes:     parseFloat(pick("BikeDurationMinutes") || 0) || 0,
      is_ebike:         parseInt(pick("IsEbike") || 0, 10) === 1,
      qs_antitheft:     parseInt(pick("QsAntitheft") || 0, 10),
      qs_light:         parseInt(pick("QsLight") || 0, 10),
      qs_brakes:        parseInt(pick("QsBrakes") || 0, 10),
      bikekey:          (pick("BikeKey") || "").toString().trim(),
      boxnumber:        (pick("BoxNumber") || "").toString().trim(),
      bike_start:       pick("BikeStart"),
      bike_end:         pick("BikeEnd"),

      // Keep raw for export
      _raw: r
    };
  }

  function normRows(raw) {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : (raw.rows || []);
    return arr.map(normRow);
  }

  /**
   * Backend daily-tracking returns:
   *   { kpi:{neueHeute,..., fakturiertHeute,...}, trend:[{Datum,Eingang,Ausgang}], lager:{...} }
   * Frontend expects:
   *   { trend_30d:[{datum, raeder, minutes}], offene_anzahl, offene_by_type:[...] }
   */
  function normDaily(raw) {
    if (!raw) return { trend_30d: [], offene_anzahl: 0, offene_by_type: [], kpi: {}, lager: {} };
    const trendIn = raw.trend || raw.trend_30d || [];
    const trend_30d = trendIn.map(t => ({
      datum:   t.Datum   || t.datum,
      raeder:  parseInt(t.Ausgang  !== undefined ? t.Ausgang  : (t.raeder  || 0), 10) || 0,
      eingang: parseInt(t.Eingang  !== undefined ? t.Eingang  : (t.eingang || 0), 10) || 0,
      minutes: parseFloat(t.minutes || 0) || 0
    }));
    return {
      trend_30d,
      kpi: raw.kpi || {},
      lager: raw.lager || {},
      offene_anzahl: (raw.lager && (raw.lager.unmontiert || raw.lager.Unmontiert)) || 0,
      offene_by_type: raw.offene_by_type || []
    };
  }

  /* ---------- Public API ---------- */

  const API = {
    login(username, password, warehouseId) {
      return request("POST", "/login", {
        body: { username, password, warehouseId: warehouseId || "HLROD" },
        noAuth: true
      });
    },

    async offeneAuftraege(filter) {
      const p = _translateFilter(filter);
      const raw = await request("GET", "/offene-auftraege", { params: p });
      return {
        rows: normRows(raw),
        from: raw && raw.from,
        to:   raw && raw.to,
        pickstatusOverview: (raw && (raw.pickstatusOverview || raw.pickstatus_overview)) || null
      };
    },

    async fakturierteAuftraege(filter) {
      const p = _translateFilter(filter);
      const raw = await request("GET", "/fakturierte-auftraege", { params: p });
      return {
        rows: normRows(raw),
        from: raw && raw.from,
        to:   raw && raw.to,
        pickstatusOverview: (raw && (raw.pickstatusOverview || raw.pickstatus_overview)) || null
      };
    },

    async dailyTracking() {
      const raw = await request("GET", "/daily-tracking");
      return normDaily(raw);
    },

    async aufbauzeiten() {
      const raw = await request("GET", "/aufbauzeiten");
      return (raw && raw.aufbauzeiten) || raw || {};
    },

    async monthlyHistory() {
      const raw = await request("GET", "/monthly-history");
      const rows = (raw && raw.rows) || [];
      return rows.map(r => ({
        yearmonth: r.YearMonth || r.yearmonth,
        jahr:      parseInt(r.Jahr  || r.jahr  || 0, 10) || 0,
        monat:     parseInt(r.Monat || r.monat || 0, 10) || 0,
        raeder:    parseInt(r.Raeder || r.raeder || 0, 10) || 0,
        rechnungen:parseInt(r.Rechnungen || r.rechnungen || 0, 10) || 0
      }));
    },

    /**
     * Lazy-Load fuer WHS-Pickstatus pro Batch. Backend hat Hard-Cap 60.
     * Gibt zurueck: Map "auftrag|xnummer" -> { pickstatus, stations }
     */
    async pickstatusBatch(orders) {
      if (!orders || !orders.length) return {};
      const raw = await request("POST", "/pickstatus-batch", { body: { orders } });
      return (raw && raw.pickstatus) || {};
    },

    /**
     * Lade den vollstaendigen Daily-Snapshot fuer das aktuelle Lager.
     * Antwort kommt gzipped (Browser dekomprimiert automatisch). Das ist
     * der EINE Aufruf, der alles enthaelt: offene + fakturiert (2J) +
     * Daily-KPIs + Trend + monthly + aufbauzeiten.
     */
    async snapshot() {
      const raw = await request("GET", "/snapshot");
      if (!raw) return null;
      return {
        version:        raw.version,
        generatedAt:    raw.generatedAt,
        warehouse:      raw.warehouse,
        warehouseName:  raw.warehouseName,
        buildSeconds:   raw.buildSeconds,
        counts:         raw.counts || {},
        offene: {
          rows: normRows((raw.offene && raw.offene.rows) || []),
          from: raw.offene && raw.offene.from,
          to:   raw.offene && raw.offene.to,
          pickstatusOverview: (raw.offene && raw.offene.pickstatusOverview) || null,
        },
        fakturiert: {
          rows: normRows((raw.fakturiert && raw.fakturiert.rows) || []),
          from: raw.fakturiert && raw.fakturiert.from,
          to:   raw.fakturiert && raw.fakturiert.to,
          note: raw.fakturiert && raw.fakturiert.note,   // wenn gesetzt: nicht im Snapshot, on-demand laden
        },
        daily:        normDaily(raw.daily || {}),
        monthly:      ((raw.monthly || []).map(r => ({
          yearmonth: r.YearMonth || r.yearmonth,
          jahr:      parseInt(r.Jahr  || r.jahr  || 0, 10) || 0,
          monat:     parseInt(r.Monat || r.monat || 0, 10) || 0,
          raeder:    parseInt(r.Raeder || r.raeder || 0, 10) || 0,
          rechnungen:parseInt(r.Rechnungen || r.rechnungen || 0, 10) || 0
        }))),
        aufbauzeiten: raw.aufbauzeiten || {}
      };
    },

    /** Manuellen Snapshot-Rebuild ausloesen (dauert 1-3 Min). */
    async rebuildSnapshot() {
      return request("POST", "/snapshot/rebuild");
    }
  };

  // Frontend uses { range, from, to, marke, kategorie }
  // Backend expects { dateRange, from, to, marke, kategorie }
  function _translateFilter(f) {
    if (!f) return {};
    const out = {};
    if (f.range)     out.dateRange = f.range;
    if (f.from)      out.from      = f.from;
    if (f.to)        out.to        = f.to;
    if (f.marke)     out.marke     = f.marke;
    if (f.kategorie) out.kategorie = f.kategorie;
    return out;
  }

  window.API = API;
  window.ApiError = ApiError;
})();
