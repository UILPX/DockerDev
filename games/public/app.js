const TOKEN_KEY = "games_token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}, auth = false) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({ ok: false, error: "bad response" }));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function currentUser() {
  const token = getToken();
  if (!token) return null;
  try {
    const r = await api("/api/auth/me", {}, true);
    return r.user;
  } catch {
    clearToken();
    return null;
  }
}

function setStatus(el, text, ok = false) {
  if (!el) return;
  el.textContent = text || "";
  el.className = `status ${ok ? "ok" : text ? "error" : ""}`;
}

window.GAMES = { getToken, setToken, clearToken, api, currentUser, setStatus };
