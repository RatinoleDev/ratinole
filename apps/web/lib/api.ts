/** Client-side calls to the API through the same-origin /api rewrite. */

export class ApiFailure extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiFailure(0, "network", "The service could not be reached. Try again in a moment.", null);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string; message?: string };
    const message =
      b.message ??
      (res.status >= 500 ? "The service is not available right now. Try again in a moment." : "Something went wrong.");
    throw new ApiFailure(res.status, b.code ?? b.error ?? String(res.status), message, body);
  }
  return body as T;
}

export function post<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(data) });
}

export function patch<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
