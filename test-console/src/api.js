const BASE = '';

let _token = null;

export function setToken(token) { _token = token; }
export function getToken() { return _token; }

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (_token) opts.headers['Authorization'] = `Bearer ${_token}`;
  if (body && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}
