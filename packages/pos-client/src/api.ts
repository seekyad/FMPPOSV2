import type { AuthResponse, SessionUser } from '@fmp/shared';

const TOKEN_KEY = 'fmp.sessionToken';
const USER_KEY = 'fmp.sessionUser';
const DEVICE_KEY = 'fmp.deviceToken';

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  get user(): SessionUser | null {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  },
  set(auth: AuthResponse) {
    localStorage.setItem(TOKEN_KEY, auth.token);
    localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
  get deviceToken() {
    return localStorage.getItem(DEVICE_KEY);
  },
  setDeviceToken(token: string) {
    localStorage.setItem(DEVICE_KEY, token);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = session.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}
