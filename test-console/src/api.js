const BASE = '';
const ADMIN_KEY = 'giftgenius_admin_secret';

let _token = null;

export function setToken(token) { _token = token; }
export function getToken() { return _token; }

export function setAdminSecret(secret) {
  if (secret) sessionStorage.setItem(ADMIN_KEY, secret);
  else sessionStorage.removeItem(ADMIN_KEY);
}

export function getAdminSecret() {
  return sessionStorage.getItem(ADMIN_KEY) || null;
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (_token) opts.headers['Authorization'] = `Bearer ${_token}`;
  if (path.startsWith('/admin')) {
    const secret = getAdminSecret();
    if (secret) opts.headers['x-admin-secret'] = secret;
  }
  if (body && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}
