/** Shape of `GET /api/health`. */
export interface HealthResponse {
  ok: boolean;
}

/**
 * Fetch the backend health status.
 *
 * Uses a relative URL: Vite proxies it in dev, Firebase Hosting rewrites it to
 * Cloud Run in production.
 * @throws Error when the request fails or returns a non-2xx status.
 */
export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("ok" in body)) {
    throw new Error("Unexpected health response");
  }
  return { ok: Boolean((body as { ok: unknown }).ok) };
}
