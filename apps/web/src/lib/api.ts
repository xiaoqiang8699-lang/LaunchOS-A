const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';


export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window === 'undefined' ? null : window.localStorage.getItem('accessToken');
  const headers = new Headers(options.headers);

  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | {
          message?: string | string[] | { message?: string; code?: string };
          code?: string;
          action?: string;
        }
      | null;
    const raw = payload?.message;
    const nested =
      typeof raw === 'object' && raw && !Array.isArray(raw)
        ? (raw as { message?: string; code?: string })
        : null;
    const message =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.join(', ')
          : typeof nested?.message === 'string'
            ? nested.message
            : '请求失败';
    const code =
      (typeof payload?.code === 'string' ? payload.code : undefined) ||
      (typeof nested?.code === 'string' ? nested.code : undefined);
    throw new ApiError(response.status, message, code, payload);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
