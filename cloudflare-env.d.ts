declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SAIL_API_KEY?: string;
    FIREWORKS_API_KEY?: string;
    // Shared daily call allowance for arena-provided agents; the SAIL_ name is the earlier spelling and still honoured.
    ARENA_DEFAULT_DAILY_CALL_LIMIT?: string;
    SAIL_DEFAULT_DAILY_CALL_LIMIT?: string;
    BUCKET?: R2Bucket;
  }
}
