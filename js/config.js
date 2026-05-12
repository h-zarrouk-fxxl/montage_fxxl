/* =============================================================
   Fahrrad XXL - Montage Dashboard
   Application Configuration
   -------------------------------------------------------------
   API_BASE zeigt auf die Azure Function App.
     Format:  https://<function-app-name>.azurewebsites.net/api
   ============================================================= */

window.APP_CONFIG = {
  // Azure Function endpoint
  API_BASE: "https://montage-fxxl.azurewebsites.net/api",

  // Fixed Lagerort shown on the login page
  LAGERORT: "Rodgau",

  // Session storage key
  TOKEN_KEY: "fxxl_montage_token",
  USER_KEY:  "fxxl_montage_user",

  // Default filter applied on first load of the dashboard.
  // "default" == today + open orders older than 10 days.
  DEFAULT_RANGE: "default",

  // Localization
  LOCALE: "de-DE",

  // UI defaults for capacity calculation
  DEFAULT_MONTEURE: 5,
  DEFAULT_STUNDEN:  7,
  DEFAULT_WORKDAYS: [1, 2, 3, 4, 5]   // Mo-Fr
};
