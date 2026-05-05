/* =============================================================
   Fahrrad XXL - Montage Dashboard
   Chart.js helpers (line, bar, gauge, donut).
   Exposes window.Charts object with render/update methods.
   ============================================================= */

(function () {

  if (typeof Chart === "undefined") {
    console.error("Chart.js not loaded");
    return;
  }

  /* -------- Global Chart.js defaults (branding) -------- */
  Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
  Chart.defaults.font.size   = 12;
  Chart.defaults.color       = "#6B7280";
  Chart.defaults.plugins.legend.position = "bottom";
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.padding = 14;

  const PALETTE = {
    red:    "#E30613",
    pink:   "#F43F5E",
    orange: "#F97316",
    amber:  "#F59E0B",
    green:  "#16A34A",
    teal:   "#14B8A6",
    blue:   "#2563EB",
    sky:    "#0EA5E9",
    violet: "#7C3AED",
    grey:   "#94A3B8"
  };
  const PALETTE_ARR = Object.values(PALETTE);

  /* Store chart instances so we can update without duplicating */
  const instances = {};

  function destroy(key) {
    if (instances[key]) {
      instances[key].destroy();
      delete instances[key];
    }
  }

  /* -------- Helpers -------- */
  function linearGradient(ctx, colorStart, colorEnd) {
    const g = ctx.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, colorStart);
    g.addColorStop(1, colorEnd);
    return g;
  }

  /* -------- Bar: Offene Aufträge by product group -------- */
  function offeneByGroup(canvasId, labels, values) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    const ctx = el.getContext("2d");
    const grad = linearGradient(ctx, "rgba(227,6,19,.85)", "rgba(244,63,94,.35)");

    instances[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Offene Stückzahl",
          data: values,
          backgroundColor: grad,
          borderColor: "#E30613",
          borderWidth: 0,
          borderRadius: 6,
          maxBarThickness: 42
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { precision: 0 } },
          x: { grid:  { display: false } }
        },
        animation: { duration: 600, easing: "easeOutQuart" }
      }
    });
  }

  /* -------- Gauge: Capacity usage today --------
     The gauge bar is capped at 100 % for the visual, but the numeric
     label (#gaugeValue) is already set by app.js with the uncapped
     actual percentage – we do NOT overwrite it here. */
  function auslastungGauge(canvasId, percent) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    const raw   = Math.max(0, Math.round(percent || 0));
    const value = Math.min(100, raw);
    const color = raw < 70 ? PALETTE.green
                 : raw < 100 ? PALETTE.amber
                 : PALETTE.red;

    instances[canvasId] = new Chart(el.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: ["Genutzt", "Frei"],
        datasets: [{
          data: [value, Math.max(100 - value, 0)],
          backgroundColor: [color, "#F1F5F9"],
          borderWidth: 0,
          cutout: "78%",
          circumference: 270,
          rotation: -135
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend:  { display: false },
          tooltip: { enabled: false }
        },
        animation: { animateRotate: true, duration: 700 }
      }
    });
  }

  /* -------- Line: fakturierte Räder pro Tag -------- */
  function faktDaily(canvasId, labels, values) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    const ctx = el.getContext("2d");
    const grad = linearGradient(ctx, "rgba(37,99,235,.25)", "rgba(37,99,235,0)");

    instances[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Fakturierte Räder",
          data: values,
          borderColor: PALETTE.blue,
          backgroundColor: grad,
          fill: true,
          tension: 0.35,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          pointBackgroundColor: "#fff",
          pointBorderColor: PALETTE.blue,
          pointBorderWidth: 2,
          borderWidth: 2.5
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { precision: 0 } },
          x: { grid:  { display: false } }
        },
        interaction: { mode: "index", intersect: false },
        animation: { duration: 600, easing: "easeOutQuart" }
      }
    });
  }

  /* -------- Bar: Top Marken fakturiert -------- */
  function topBrands(canvasId, labels, values) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;

    instances[canvasId] = new Chart(el.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: PALETTE_ARR.slice(0, labels.length),
          borderRadius: 6,
          maxBarThickness: 28
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { precision: 0 } },
          y: { grid:  { display: false } }
        },
        animation: { duration: 600 }
      }
    });
  }

  /* -------- Line: 30-day tracking (daily-tracking tab) -------- */
  function tracking30d(canvasId, labels, values) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    const ctx = el.getContext("2d");
    const grad = linearGradient(ctx, "rgba(22,163,74,.25)", "rgba(22,163,74,0)");

    instances[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Fakturiert",
          data: values,
          borderColor: PALETTE.green,
          backgroundColor: grad,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: "#fff",
          pointBorderColor: PALETTE.green,
          pointBorderWidth: 2,
          borderWidth: 2.5
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { precision: 0 } },
          x: { grid:  { display: false } }
        },
        animation: { duration: 700 }
      }
    });
  }

  /* -------- Donut: by bike type -------- */
  function donutBikeType(canvasId, labels, values) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;

    instances[canvasId] = new Chart(el.getContext("2d"), {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: [
            PALETTE.red, PALETTE.pink, PALETTE.orange, PALETTE.amber,
            PALETTE.blue, PALETTE.sky, PALETTE.green, PALETTE.teal, PALETTE.violet, PALETTE.grey
          ],
          borderColor: "#fff",
          borderWidth: 2,
          cutout: "62%"
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right" } },
        animation: { animateRotate: true, duration: 700 }
      }
    });
  }

  /* -------- Bar comparison: months this year vs previous year -------- */
  function monthlyComparison(canvasId, labels, curValues, prevValues, curYear, prevYear) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    const ctx = el.getContext("2d");
    const gradCur  = linearGradient(ctx, "rgba(227,6,19,.85)",  "rgba(227,6,19,.40)");
    const gradPrev = linearGradient(ctx, "rgba(148,163,184,.75)", "rgba(148,163,184,.30)");

    instances[canvasId] = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: String(prevYear),
            data: prevValues,
            backgroundColor: gradPrev,
            borderRadius: 4,
            maxBarThickness: 26,
            order: 2
          },
          {
            label: String(curYear),
            data: curValues,
            backgroundColor: gradCur,
            borderRadius: 4,
            maxBarThickness: 26,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend:  { position: "bottom" },
          tooltip: {
            callbacks: {
              footer: (items) => {
                if (items.length < 2) return "";
                const cur  = curValues[items[0].dataIndex]  || 0;
                const prev = prevValues[items[0].dataIndex] || 0;
                if (!prev) return "";
                const pct = ((cur - prev) / prev) * 100;
                const sign = pct >= 0 ? "+" : "";
                return `\u0394 ${sign}${pct.toFixed(1)} %`;
              }
            }
          }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { precision: 0 } },
          x: { grid: { display: false } }
        },
        animation: { duration: 700, easing: "easeOutQuart" }
      }
    });
  }

  window.Charts = {
    offeneByGroup,
    auslastungGauge,
    faktDaily,
    topBrands,
    tracking30d,
    donutBikeType,
    monthlyComparison,
    destroy,
    PALETTE
  };

})();
