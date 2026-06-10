interface RateLimitBucket {
  timestamps: number[];
}

export type RateTier = "destructive" | "mutate";

export class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private globalBucket: RateLimitBucket = { timestamps: [] };

  private globalMaxRequests: number;
  private globalWindowMs: number;

  private toolLimits = new Map<string, { maxRequests: number; windowMs: number }>();

  /**
   * @param toolTiers per-tool rate tier, derived from the registered tools so
   *   the limits can never drift out of sync with a renamed or new tool.
   */
  constructor(
    toolTiers: Map<string, RateTier> = new Map(),
    globalMaxRequests = 100,
    globalWindowMs = 60_000
  ) {
    this.globalMaxRequests = globalMaxRequests;
    this.globalWindowMs = globalWindowMs;

    const destructiveLimits = { maxRequests: 5, windowMs: 60_000 };
    const mutateLimits = { maxRequests: 10, windowMs: 60_000 };

    for (const [tool, tier] of toolTiers) {
      this.toolLimits.set(
        tool,
        tier === "destructive" ? destructiveLimits : mutateLimits
      );
    }
  }

  check(toolName: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();

    // Check global limit
    this.pruneTimestamps(this.globalBucket, now, this.globalWindowMs);
    if (this.globalBucket.timestamps.length >= this.globalMaxRequests) {
      const oldest = this.globalBucket.timestamps[0];
      return {
        allowed: false,
        retryAfterMs: oldest + this.globalWindowMs - now,
      };
    }

    // Check per-tool limit
    const limit = this.toolLimits.get(toolName);
    if (limit) {
      if (!this.buckets.has(toolName)) {
        this.buckets.set(toolName, { timestamps: [] });
      }
      const bucket = this.buckets.get(toolName)!;
      this.pruneTimestamps(bucket, now, limit.windowMs);

      if (bucket.timestamps.length >= limit.maxRequests) {
        const oldest = bucket.timestamps[0];
        return {
          allowed: false,
          retryAfterMs: oldest + limit.windowMs - now,
        };
      }

      bucket.timestamps.push(now);
    }

    this.globalBucket.timestamps.push(now);
    return { allowed: true };
  }

  private pruneTimestamps(
    bucket: RateLimitBucket,
    now: number,
    windowMs: number
  ): void {
    const cutoff = now - windowMs;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
      bucket.timestamps.shift();
    }
  }
}
