/* =============================================================
   Fahrrad XXL - Montage Dashboard
   Auth handler (token storage + login / logout)
   ============================================================= */

(function () {
  const Auth = {

    async login(username, password, warehouseId) {
      const res = await API.login(username, password, warehouseId);
      if (res && res.token) {
        localStorage.setItem(APP_CONFIG.TOKEN_KEY, res.token);
        localStorage.setItem(APP_CONFIG.USER_KEY,  JSON.stringify({
          user:        res.user        || username,
          lagerort:    res.lagerort    || APP_CONFIG.LAGERORT,
          warehouseId: res.warehouseId || warehouseId || "HLROD",
          loginAt:     Date.now(),
          expires:     res.expiresIn ? (Date.now() + res.expiresIn * 1000) : null
        }));
        if (res.warehouseId) {
          localStorage.setItem("warehouseId", res.warehouseId);
        }
      }
      return res;
    },

    logout() {
      localStorage.removeItem(APP_CONFIG.TOKEN_KEY);
      localStorage.removeItem(APP_CONFIG.USER_KEY);
      // warehouseId bleibt erhalten, damit die nächste Anmeldung den
      // zuletzt gewählten Lagerort vorselektiert.
      location.replace("login.html");
    },

    getToken() {
      return localStorage.getItem(APP_CONFIG.TOKEN_KEY);
    },

    getUser() {
      try   { return JSON.parse(localStorage.getItem(APP_CONFIG.USER_KEY)); }
      catch { return null; }
    },

    getWarehouseId() {
      const u = Auth.getUser();
      return (u && u.warehouseId) || localStorage.getItem("warehouseId") || "HLROD";
    },

    /**
     * On the dashboard side: force to login if no token.
     */
    requireAuth() {
      if (!Auth.getToken()) {
        location.replace("login.html");
        return false;
      }
      const u = Auth.getUser();
      if (u && u.expires && Date.now() > u.expires) {
        Auth.logout();
        return false;
      }
      return true;
    }
  };

  window.Auth = Auth;
})();
