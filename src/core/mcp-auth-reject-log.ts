import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One warning when HTTP MCP bearer auth rejects a request.
 * The line carries a reason code, method, path, a truncated user agent,
 * the first X-Forwarded-For hop, and client_id only when verification
 * already resolved it. It never carries token material.
 */

export const AUTH_REJECT_WINDOW_MS = 60_000;

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

/** First X-Forwarded-For hop, else the socket address. */
export function authRejectSourceIp(forwardedFor: unknown, fallback: string | undefined): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof raw === 'string' && raw.length > 0) {
    const first = raw.split(',')[0]?.trim() ?? '';
    if (first) return cleanOneLine(first, 80);
  }
  return cleanOneLine(fallback ?? '', 80) || 'unknown';
}

export interface AuthRejectFields {
  reason: string;
  method: string;
  path: string;
  userAgent: string;
  ip: string;
  clientId?: string;
  suppressed: number;
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
  if (fields.clientId) payload.client_id = fields.clientId;
  return `[mcp-auth] reject ${JSON.stringify(payload)}`;
}

export interface AuthRejectLimiter {
  decide(key: string, now: number): { emit: boolean; suppressed: number };
}

export function createAuthRejectLimiter(windowMs = AUTH_REJECT_WINDOW_MS): AuthRejectLimiter {
  const buckets = new Map<string, { lastEmit: number; suppressed: number }>();
  return {
    decide(key: string, now: number) {
      if (buckets.size > 4096) {
        for (const [bucketKey, bucket] of buckets) {
          if (now - bucket.lastEmit > windowMs * 10) buckets.delete(bucketKey);
        }
      }
      const existing = buckets.get(key);
      if (!existing || now - existing.lastEmit >= windowMs) {
        const suppressed = existing?.suppressed ?? 0;
        buckets.set(key, { lastEmit: now, suppressed: 0 });
        return { emit: true, suppressed };
      }
      existing.suppressed += 1;
      return { emit: false, suppressed: existing.suppressed };
    },
  };
}

export function authRejectRateKey(reason: string, ip: string, userAgent: string): string {
  return JSON.stringify([reason, ip, userAgent]);
}

function cleanOneLine(value: string, max: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[ ]+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function cleanClientId(value: string): string | undefined {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > 200) return undefined;
  return cleaned;
}
