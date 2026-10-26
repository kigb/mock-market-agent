declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SAIL_API_KEY?: string;
    SAIL_DEFAULT_DAILY_CALL_LIMIT?: string;
    BUCKET?: R2Bucket;
  }
}
