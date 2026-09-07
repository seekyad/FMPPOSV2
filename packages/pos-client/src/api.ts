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

export type PosSystem = 'repair' | 'retail';

/**
 * Cross-system switching. In production both apps share one origin
 * (/ and /retail) so localStorage already carries the session; in dev they run
 * on different ports, so the session rides along in the URL hash.
 */
export function switchSystemUrl(target: PosSystem): string {
  const payload = encodeURIComponent(
    JSON.stringify({
      token: session.token,
      user: localStorage.getItem(USER_KEY),
      deviceToken: session.deviceToken,
    }),
  );
  const hash = `#fmp-session=${payload}`;
  const isDev = window.location.port === '5173' || window.location.port === '5174';
  if (isDev) {
    return target === 'retail' ? `http://localhost:5174/retail/${hash}` : `http://localhost:5173/${hash}`;
  }
  return target === 'retail' ? `/retail/${hash}` : `/${hash}`;
}

/** Pick up a session handed over from the other system (call once at startup). */
export function adoptSessionFromHash(): void {
  const match = window.location.hash.match(/fmp-session=([^&]+)/);
  if (!match) return;
  try {
    const payload = JSON.parse(decodeURIComponent(match[1]!)) as {
      token?: string | null;
      user?: string | null;
      deviceToken?: string | null;
    };
    if (payload.token) localStorage.setItem(TOKEN_KEY, payload.token);
    if (payload.user) localStorage.setItem(USER_KEY, payload.user);
    if (payload.deviceToken) localStorage.setItem(DEVICE_KEY, payload.deviceToken);
  } catch {
    // malformed hash — ignore
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

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
