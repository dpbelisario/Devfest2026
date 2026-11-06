/**
 * Fixed-window request limiter kept in process memory. It bounds model spend
 * per Cloud Run instance; it is not a security boundary.
 */
export class RateLimiter {
  private windowStart = 0;
  private total = 0;
  private readonly perKey = new Map<string, number>();

  constructor(
    private readonly options: {
      windowMs: number;
      perKeyLimit: number;
      totalLimit: number;
      now?: () => number;
    },
  ) {}

  /** Records one request for `key`; false when it should be rejected. */
  take(key: string): boolean {
    const now = (this.options.now ?? Date.now)();
    if (now - this.windowStart >= this.options.windowMs) {
      this.windowStart = now;
      this.total = 0;
      this.perKey.clear();
    }
    const used = this.perKey.get(key) ?? 0;
    if (
      used >= this.options.perKeyLimit ||
      this.total >= this.options.totalLimit
    )
      return false;
    this.perKey.set(key, used + 1);
    this.total += 1;
    return true;
  }
}
