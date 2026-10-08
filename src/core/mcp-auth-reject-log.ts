import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One warning when HTTP MCP bearer auth rejects a request.
 * The line carries a reason code, method, path, a truncated user agent,
 * Express `req.ip` (trust-proxy, never the raw X-Forwarded-For header),
 * and client_id only when verification already resolved it.
 * It never carries token material.
 */

export const AUTH_REJECT_WINDOW_MS = 60_000;
/** Hard cap on tracked (reason, ip, user agent) buckets. */
export const AUTH_REJECT_BUCKET_CAP = 4096;
/** Drop a bucket this many windows after its last emit, when a sweep runs. */
export const AUTH_REJECT_STALE_WINDOWS = 10;
/**
 * Stale sweep at most this often. The sweep walks from the oldest emit and
 * stops at the first fresh bucket, so it is not a full-map scan per reject.
 */
export const AUTH_REJECT_SWEEP_INTERVAL_MS = 60_000;
/**
 * Lines actually written per window, across every key. Unique keys cannot
 * each take a line. Overflow is one counter, reported on the next line.
 */
export const AUTH_REJECT_GLOBAL_LINES_PER_WINDOW = 30;

/** C0, DEL, C1, and the Unicode line separators log viewers still split on. */
const LOG_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Set only inside the MCP auth middleware. Absent on every other caller. */
const hintStore = new AsyncLocalStorage<{ clientId?: string }>();

export function runWithAuthRejectHint<T>(fn: () => T): T {
  return hintStore.run({}, fn);
}

/**
 * Record a client id that verification already resolved from the token row.
 * No-op outside the auth middleware, and it never receives the token.
 */
export function rememberAuthRejectClient(clientId: unknown): void {
  if (typeof clientId !== 'string') return;
  const store = hintStore.getStore();
  if (!store) return;
  const cleaned = cleanClientId(clientId);
  if (cleaned) store.clientId = cleaned;
}

export function currentAuthRejectClient(): string | undefined {
  return hintStore.getStore()?.clientId;
}

export function authRejectReason(body: unknown): string {
  if (!body || typeof body !== 'object') return 'rejected';
  const record = body as { error?: unknown; error_description?: unknown };
  const message = typeof record.error_description === 'string' ? record.error_description : '';
  switch (message) {
    case 'Missing Authorization header': return 'missing_header';
    case "Invalid Authorization header format, expected 'Bearer TOKEN'": return 'invalid_header';
    case 'Invalid token': return 'invalid_token';
    case 'Token expired':
    case 'Token has expired': return 'expired';
    case 'Client revoked or missing': return 'revoked';
    case 'Token is bound to a different resource': return 'wrong_audience';
    case 'Insufficient scope': return 'insufficient_scope';
    case 'Token has no expiration time': return 'no_expiration';
    default: {
      if (message.startsWith('Client grant schema incomplete')) return 'grant_schema';
      if (record.error === 'insufficient_scope') return 'insufficient_scope';
      if (record.error === 'invalid_token') return 'invalid_token';
      return 'rejected';
    }
  }
}

export function truncateUserAgent(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = typeof raw === 'string' ? raw : '';
  return cleanOneLine(text, 120);
}

/**
 * Address for the reject log and its rate-limit key.
 *
 * `trusted` is Express `req.ip`. That value already applied
 * `app.set('trust proxy', resolveTrustProxy(GBRAIN_HTTP_TRUST_PROXY))`
 * in `serve-http.ts`. The default is `loopback`. A Railway (or any other)
 * edge is not a loopback peer, so `req.ip` stays the proxy address and a
 * client-supplied X-Forwarded-For hop is ignored. That is the same address
 * the HTTP rate limiter sees. `GBRAIN_HTTP_TRUST_PROXY=1` trusts exactly
 * one hop, the single-proxy setting this server already uses for rate
 * limits and `req.secure`. This function does not read or walk
 * X-Forwarded-For.
 *
 * The socket address is only a fallback when `req.ip` is empty.
 */
export function authRejectClientIp(trusted: string | undefined, socketFallback: string | undefined): string {
  const primary = cleanOneLine(trusted ?? '', 80);
  if (primary) return primary;
  return cleanOneLine(socketFallback ?? '', 80) || 'unknown';
}

export interface AuthRejectFields {
  reason: string;
  method: string;
  path: string;
  userAgent: string;
  ip: string;
  clientId?: string;
  suppressed: number;
  /** Lines the global ceiling held back since the previous emitted line. */
  globalSuppressed?: number;
}

export function authRejectLogLine(fields: AuthRejectFields): string {
  const payload: Record<string, string | number> = {
    reason: fields.reason,
    method: fields.method,
    path: fields.path,
    user_agent: fields.userAgent,
    ip: fields.ip,
    suppressed: fields.suppressed,
  };
  if (fields.globalSuppressed) payload.global_suppressed = fields.globalSuppressed;
  if (fields.clientId) payload.client_id = fields.clientId;
  return `[mcp-auth] reject ${JSON.stringify(payload)}`;
}

export interface AuthRejectDecision {
  emit: boolean;
  /** Per-key repeats since that key's last emitted line. Zero when nothing is logged. */
  suppressed: number;
  /** Global overflow reported on this line. Zero when nothing is logged. */
  globalSuppressed: number;
}

export interface AuthRejectLimiter {
  decide(key: string, now: number): AuthRejectDecision;
  /** Tracked buckets. Never above the cap after `decide` returns. */
  size(): number;
}

export interface AuthRejectLimiterOptions {
  cap?: number;
  sweepIntervalMs?: number;
  globalLinesPerWindow?: number;
}

export function createAuthRejectLimiter(
  windowMs = AUTH_REJECT_WINDOW_MS,
  options: AuthRejectLimiterOptions = {},
): AuthRejectLimiter {
  const cap = positiveCap(options.cap, AUTH_REJECT_BUCKET_CAP);
  const sweepIntervalMs = positiveCap(options.sweepIntervalMs, AUTH_REJECT_SWEEP_INTERVAL_MS);
  const globalLines = positiveCap(options.globalLinesPerWindow, AUTH_REJECT_GLOBAL_LINES_PER_WINDOW);
  const staleMs = windowMs * AUTH_REJECT_STALE_WINDOWS;
  // Insertion order is last-emit order: an emit deletes and reinserts.
  const buckets = new Map<string, { lastEmit: number; suppressed: number }>();
  let lastSweep = Number.NEGATIVE_INFINITY;
  let globalWindowStart = Number.NEGATIVE_INFINITY;
  let globalEmitted = 0;
  let globalSuppressed = 0;

  const addGlobal = (count: number) => {
    const n = safeCount(count);
    if (n === 0) return;
    const room = Number.MAX_SAFE_INTEGER - globalSuppressed;
    globalSuppressed += n > room ? room : n;
  };

  // Oldest lastEmit is at the front. One delete per extra entry, no scan.
  const evictOverflow = () => {
    while (buckets.size > cap) {
      const oldest = buckets.keys().next();
      if (oldest.done) return;
      const bucket = buckets.get(oldest.value);
      buckets.delete(oldest.value);
      if (bucket) addGlobal(bucket.suppressed);
    }
  };

  const sweepStale = (now: number) => {
    if (now - lastSweep < sweepIntervalMs) return;
    lastSweep = now;
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.lastEmit <= staleMs) break;
      buckets.delete(bucketKey);
      addGlobal(bucket.suppressed);
    }
    evictOverflow();
  };

  const takeGlobalSlot = (now: number): { allow: boolean; report: number } => {
    if (now - globalWindowStart >= windowMs) {
      globalWindowStart = now;
      globalEmitted = 0;
    }
    if (globalEmitted >= globalLines) {
      addGlobal(1);
      return { allow: false, report: 0 };
    }
    globalEmitted += 1;
    const report = globalSuppressed;
    globalSuppressed = 0;
    return { allow: true, report };
  };

  return {
    size: () => buckets.size,
    decide(key: string, now: number): AuthRejectDecision {
      sweepStale(now);
      const existing = buckets.get(key);
      if (existing && now - existing.lastEmit < windowMs) {
        existing.suppressed = safeCount(existing.suppressed + 1);
        return { emit: false, suppressed: existing.suppressed, globalSuppressed: 0 };
      }
      const pending = safeCount(existing?.suppressed ?? 0);
      if (existing) buckets.delete(key);
      buckets.set(key, { lastEmit: now, suppressed: 0 });
      evictOverflow();
      const slot = takeGlobalSlot(now);
      if (!slot.allow) {
        const kept = buckets.get(key);
        if (kept) kept.suppressed = pending;
        else addGlobal(pending);
        return { emit: false, suppressed: 0, globalSuppressed: 0 };
      }
      return { emit: true, suppressed: pending, globalSuppressed: slot.report };
    },
  };
}

export function authRejectRateKey(reason: string, ip: string, userAgent: string): string {
  return JSON.stringify([reason, ip, userAgent]);
}

function cleanOneLine(value: string, max: number): string {
  const cleaned = value.replace(LOG_UNSAFE, ' ').replace(/[ ]+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function cleanClientId(value: string): string | undefined {
  const cleaned = value.replace(LOG_UNSAFE, '').trim();
  if (!cleaned || cleaned.length > 200) return undefined;
  return cleaned;
}

function positiveCap(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function safeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.floor(value);
}
