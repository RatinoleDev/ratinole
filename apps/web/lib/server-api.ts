const API = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

/**
 * Server-side read of a public endpoint. Returns null on any failure so pages
 * render their empty states (the build must succeed with the API down).
 */
export async function serverGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}/api${path}`, {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
