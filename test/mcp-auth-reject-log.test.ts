import { describe, expect, test } from 'bun:test';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError, InsufficientScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { hashToken } from '../src/core/utils.ts';
import {
  AUTH_REJECT_BUCKET_CAP,
  AUTH_REJECT_STALE_WINDOWS,
  AUTH_REJECT_WINDOW_MS,
  authRejectClientIp,
  authRejectLogLine,
  authRejectRateKey,
  authRejectReason,
  createAuthRejectLimiter,
  rememberAuthRejectClient,
  runWithAuthRejectHint,
  truncateUserAgent,
} from '../src/core/mcp-auth-reject-log.ts';
import { withMcpAuthRejectLog } from '../src/commands/serve-http-auth-reject.ts';

const SECRET = 'gb-secret-token-7f3c9a2e1b84d056';
const SECRET_PREFIX = 'gb-secret-token';

describe('auth reject reason and fields', () => {
  test('maps the bearer and verifier messages onto reason codes', () => {
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Missing Authorization header' })).toBe('missing_header');
    expect(authRejectReason({ error: 'invalid_token', error_description: "Invalid Authorization header format, expected 'Bearer TOKEN'" })).toBe('invalid_header');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Invalid token' })).toBe('invalid_token');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Token expired' })).toBe('expired');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Token has expired' })).toBe('expired');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Client revoked or missing' })).toBe('revoked');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Token is bound to a different resource' })).toBe('wrong_audience');
    expect(authRejectReason({ error: 'insufficient_scope', error_description: 'Insufficient scope' })).toBe('insufficient_scope');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Token has no expiration time' })).toBe('no_expiration');
    expect(authRejectReason({ error: 'invalid_token', error_description: 'Client grant schema incomplete; run gbrain apply-migrations --yes' })).toBe('grant_schema');
    expect(authRejectReason({ error: 'invalid_token', error_description: `Invalid token ${SECRET}` })).toBe('invalid_token');
  });

  test('truncates the user agent and uses the trusted address, not a forwarded hop', () => {
    expect(truncateUserAgent('a'.repeat(150))).toHaveLength(120);
    expect(truncateUserAgent('line\r\none')).toBe('line one');
    expect(truncateUserAgent('a\u2028b\u2029c\u0085d')).toBe('a b c d');
    expect(authRejectClientIp('192.0.2.10', '127.0.0.1')).toBe('192.0.2.10');
    expect(authRejectClientIp(undefined, '192.0.2.4')).toBe('192.0.2.4');
    expect(authRejectClientIp('', undefined)).toBe('unknown');
    expect(authRejectClientIp('192.0.2.10', '203.0.113.9')).not.toBe('203.0.113.9');
  });

  test('emits at most one line a minute and reports the suppressed count', () => {
    const limiter = createAuthRejectLimiter();
    const key = authRejectRateKey('invalid_token', '203.0.113.9', 'retry-bot');
    const quiet = { globalSuppressed: 0 };
    expect(limiter.decide(key, 0)).toEqual({ emit: true, suppressed: 0, ...quiet });
    expect(limiter.decide(key, 1_000)).toEqual({ emit: false, suppressed: 1, ...quiet });
    expect(limiter.decide(key, 30_000)).toEqual({ emit: false, suppressed: 2, ...quiet });
    expect(limiter.decide(key, AUTH_REJECT_WINDOW_MS)).toEqual({ emit: true, suppressed: 2, ...quiet });
    expect(limiter.decide(key, AUTH_REJECT_WINDOW_MS + 1)).toEqual({ emit: false, suppressed: 1, ...quiet });
  });

  test('stays at the bucket cap for a flood of fresh unique keys', () => {
    const limiter = createAuthRejectLimiter(AUTH_REJECT_WINDOW_MS, { globalLinesPerWindow: 100_000 });
    let max = 0;
    for (let i = 0; i < 10_000; i++) {
      limiter.decide(`k${i}`, 1_000);
      const size = limiter.size();
      if (size > max) max = size;
      expect(size).toBeLessThanOrEqual(AUTH_REJECT_BUCKET_CAP);
    }
    expect(max).toBe(AUTH_REJECT_BUCKET_CAP);
    expect(limiter.size()).toBe(AUTH_REJECT_BUCKET_CAP);
  });

  test('the stale sweep does not run on every reject', () => {
    const sweepIntervalMs = 30 * AUTH_REJECT_WINDOW_MS;
    const limiter = createAuthRejectLimiter(AUTH_REJECT_WINDOW_MS, {
      sweepIntervalMs,
      globalLinesPerWindow: 100_000,
    });
    for (let i = 0; i < 50; i++) limiter.decide(`s${i}`, 0);
    expect(limiter.size()).toBe(50);
    const staleAt = AUTH_REJECT_WINDOW_MS * AUTH_REJECT_STALE_WINDOWS + 1;
    expect(staleAt).toBeLessThan(sweepIntervalMs);
    limiter.decide('fresh', staleAt);
    expect(limiter.size()).toBe(51);
    limiter.decide('later', sweepIntervalMs);
    expect(limiter.size()).toBe(1);
  });

  test('a global line ceiling folds overflow into the next emitted line', () => {
    const limiter = createAuthRejectLimiter(AUTH_REJECT_WINDOW_MS, { globalLinesPerWindow: 3, cap: 100 });
    const first = [];
    for (let i = 0; i < 10; i++) first.push(limiter.decide(`g${i}`, 0));
    expect(first.filter((d) => d.emit)).toHaveLength(3);
    expect(first.filter((d) => !d.emit)).toHaveLength(7);
    expect(limiter.size()).toBe(10);
    const next = limiter.decide('g-next', AUTH_REJECT_WINDOW_MS);
    expect(next).toEqual({ emit: true, suppressed: 0, globalSuppressed: 7 });
  });

  test('an evicted bucket does not throw or attach its count to another key', () => {
    const limiter = createAuthRejectLimiter(AUTH_REJECT_WINDOW_MS, { cap: 2, globalLinesPerWindow: 100 });
    expect(limiter.decide('a', 0).emit).toBe(true);
    expect(limiter.decide('a', 1)).toEqual({ emit: false, suppressed: 1, globalSuppressed: 0 });
    expect(limiter.decide('a', 2)).toEqual({ emit: false, suppressed: 2, globalSuppressed: 0 });
    expect(limiter.decide('b', 0).suppressed).toBe(0);
    const evict = limiter.decide('c', 0);
    expect(evict).toEqual({ emit: true, suppressed: 0, globalSuppressed: 2 });
    expect(limiter.size()).toBe(2);
    expect(limiter.decide('a', 3)).toEqual({ emit: true, suppressed: 0, globalSuppressed: 0 });
    expect(limiter.decide('c', 1)).toEqual({ emit: false, suppressed: 1, globalSuppressed: 0 });
  });

  test('the log line omits client_id until one was resolved', () => {
    const base = { reason: 'missing_header', method: 'POST', path: '/mcp', userAgent: 'agent', ip: '203.0.113.9', suppressed: 0 };
    expect(authRejectLogLine(base)).not.toContain('client_id');
    expect(JSON.parse(authRejectLogLine({ ...base, clientId: 'client-a' }).replace('[mcp-auth] reject ', '')).client_id).toBe('client-a');
  });
});

describe('HTTP MCP bearer rejection log', () => {
  function invoke(
    authorization: string | undefined,
    verifier: OAuthTokenVerifier,
    opts: { now?: () => number; requiredScopes?: string[]; userAgent?: string; forwardedFor?: string; ip?: string; path?: string } = {},
  ): Promise<{ status: number; lines: string[] }> {
    const lines: string[] = [];
    const middleware = withMcpAuthRejectLog(
      requireBearerAuth({ verifier, requiredScopes: opts.requiredScopes ?? [] }),
      { warn: line => lines.push(line), now: opts.now ?? (() => 0), limiter: opts.now ? sharedLimiter : createAuthRejectLimiter() },
    );
    const headers: Record<string, string> = {
      'user-agent': opts.userAgent ?? 'phrase-retry/1',
      'x-forwarded-for': opts.forwardedFor ?? '203.0.113.9, 10.1.1.1',
    };
    if (authorization !== undefined) headers.authorization = authorization;
    const req = {
      method: 'POST',
      path: opts.path ?? '/mcp',
      url: opts.path ?? '/mcp',
      ip: opts.ip ?? '192.0.2.10',
      socket: { remoteAddress: '127.0.0.1' },
      headers,
    };
    const res: {
      statusCode: number;
      body?: unknown;
      status: (code: number) => typeof res;
      set: (name: string, value: string) => typeof res;
      json: (body: unknown) => typeof res;
    } = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      set() { return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    return Promise.resolve(middleware(req as never, res as never, () => { res.statusCode = 200; })).then(() => ({
      status: res.statusCode,
      lines,
    }));
  }

  const sharedLimiter = createAuthRejectLimiter();
  let clock = 0;

  test('missing header logs the reason and no token field', async () => {
    const verifier = { async verifyAccessToken(token: string) { throw new InvalidTokenError(token); } };
    const { status, lines } = await invoke(undefined, verifier);
    expect(status).toBe(401);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.replace('[mcp-auth] reject ', ''));
    expect(payload).toEqual({
      reason: 'missing_header',
      method: 'POST',
      path: '/mcp',
      user_agent: 'phrase-retry/1',
      ip: '192.0.2.10',
      suppressed: 0,
    });
    expect(lines[0]).not.toContain('203.0.113.9');
    expect(lines[0]).not.toContain('authorization');
    expect(lines[0]).not.toContain('Authorization');
  });

  test('invalid token logs no token, prefix, hash or Authorization header', async () => {
    const hash = hashToken(SECRET);
    const verifier = {
      async verifyAccessToken() {
        throw new InvalidTokenError(`Invalid token ${SECRET}`);
      },
    };
    const { status, lines } = await invoke(`Bearer ${SECRET}`, verifier, { userAgent: 'storm/1' });
    expect(status).toBe(401);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const payload = JSON.parse(line.replace('[mcp-auth] reject ', ''));
    expect(payload.reason).toBe('invalid_token');
    expect(payload.client_id).toBeUndefined();
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(SECRET_PREFIX);
    expect(line).not.toContain(hash);
    expect(line).not.toContain('Bearer');
    expect(line).not.toContain('Authorization');
    expect(line).not.toContain('authorization');
    expect(line).not.toContain('203.0.113.9');
    expect(payload.ip).toBe('192.0.2.10');
  });

  test('includes client_id only after verification resolved it', async () => {
    const verifier = {
      async verifyAccessToken(token: string) {
        if (token === 'tok-past-ttl') {
          rememberAuthRejectClient('client-past-ttl');
          throw new InvalidTokenError('Token expired');
        }
        rememberAuthRejectClient('client-read');
        return { token, clientId: 'client-read', scopes: ['read'], expiresAt: Math.floor(Date.now() / 1000) + 60 };
      },
    };
    const expired = await invoke('Bearer tok-past-ttl', verifier);
    expect(expired.status).toBe(401);
    const expiredPayload = JSON.parse(expired.lines[0]!.replace('[mcp-auth] reject ', ''));
    expect(expiredPayload.reason).toBe('expired');
    expect(expiredPayload.client_id).toBe('client-past-ttl');
    expect(expired.lines[0]).not.toContain('tok-past-ttl');

    const denied = await invoke('Bearer read-only-token', verifier, { requiredScopes: ['write'], userAgent: 'scope-probe/1' });
    expect(denied.status).toBe(403);
    const deniedPayload = JSON.parse(denied.lines[0]!.replace('[mcp-auth] reject ', ''));
    expect(deniedPayload.reason).toBe('insufficient_scope');
    expect(deniedPayload.client_id).toBe('client-read');
    expect(denied.lines[0]).not.toContain('read-only-token');
  });

  test('a retry storm logs once a minute with the suppressed count', async () => {
    clock = 1_000;
    const verifier = { async verifyAccessToken() { throw new InvalidTokenError('Invalid token'); } };
    const storm = { now: () => clock, userAgent: 'storm/2', ip: '198.51.100.7' };
    const first = await invoke('Bearer one', verifier, { ...storm, forwardedFor: '203.0.113.50' });
    clock = 2_000;
    const second = await invoke('Bearer two', verifier, { ...storm, forwardedFor: '203.0.113.51' });
    clock = 3_000;
    const third = await invoke('Bearer three', verifier, { ...storm, forwardedFor: '203.0.113.52' });
    expect(first.lines).toHaveLength(1);
    expect(JSON.parse(first.lines[0]!.replace('[mcp-auth] reject ', '')).suppressed).toBe(0);
    expect(second.lines).toHaveLength(0);
    expect(third.lines).toHaveLength(0);
    clock = 1_000 + AUTH_REJECT_WINDOW_MS;
    const later = await invoke('Bearer four', verifier, { ...storm, forwardedFor: '203.0.113.53' });
    expect(later.lines).toHaveLength(1);
    expect(JSON.parse(later.lines[0]!.replace('[mcp-auth] reject ', '')).suppressed).toBe(2);
    expect(JSON.parse(later.lines[0]!.replace('[mcp-auth] reject ', '')).ip).toBe('198.51.100.7');
    expect(later.lines[0]).not.toContain('203.0.113');
    for (const token of ['one', 'two', 'three', 'four']) {
      expect(later.lines[0]).not.toContain(token);
    }
  });

  test('a successful check writes nothing', async () => {
    const verifier = {
      async verifyAccessToken(token: string) {
        return { token, clientId: 'client-ok', scopes: ['read'], expiresAt: Math.floor(Date.now() / 1000) + 60 };
      },
    };
    const { status, lines } = await invoke(`Bearer ${SECRET}`, verifier);
    expect(status).toBe(200);
    expect(lines).toEqual([]);
  });

  test('line separators in the path do not reach the log', async () => {
    const verifier = { async verifyAccessToken() { throw new InvalidTokenError('Invalid token'); } };
    const { lines } = await invoke(undefined, verifier, { path: '/mcp\u2028\u0085next', userAgent: 'path\u2029probe' });
    expect(lines[0]).not.toContain('\u2028');
    expect(lines[0]).not.toContain('\u2029');
    expect(lines[0]).not.toContain('\u0085');
    expect(JSON.parse(lines[0]!.replace('[mcp-auth] reject ', '')).path).toBe('/mcpnext');
    expect(JSON.parse(lines[0]!.replace('[mcp-auth] reject ', '')).user_agent).toBe('path probe');
  });

  test('user agent is truncated to 120 characters', async () => {
    const verifier = { async verifyAccessToken() { throw new InvalidTokenError('Invalid token'); } };
    const { lines } = await invoke(undefined, verifier, { userAgent: 'U'.repeat(180) });
    expect(JSON.parse(lines[0]!.replace('[mcp-auth] reject ', '')).user_agent).toHaveLength(120);
  });

  test('wrong audience and revoked keep their reason codes', async () => {
    const verifier = {
      async verifyAccessToken(token: string) {
        rememberAuthRejectClient(token === 'revoked-token' ? 'client-revoked' : 'client-aud');
        throw new InvalidTokenError(token === 'revoked-token' ? 'Client revoked or missing' : 'Token is bound to a different resource');
      },
    };
    const audience = await invoke('Bearer audience-token', verifier);
    expect(JSON.parse(audience.lines[0]!.replace('[mcp-auth] reject ', '')).reason).toBe('wrong_audience');
    const revoked = await invoke('Bearer revoked-token', verifier, { userAgent: 'other-agent' });
    expect(JSON.parse(revoked.lines[0]!.replace('[mcp-auth] reject ', '')).reason).toBe('revoked');
    expect(JSON.parse(revoked.lines[0]!.replace('[mcp-auth] reject ', '')).client_id).toBe('client-revoked');
  });
});

describe('client hint does not escape the middleware', () => {
  test('rememberAuthRejectClient is a no-op without the middleware store', () => {
    rememberAuthRejectClient('should-not-stick');
    expect(runWithAuthRejectHint(() => {
      rememberAuthRejectClient('inside');
      return true;
    })).toBe(true);
  });

  test('insufficient scope error class stays a 403 reason', () => {
    const error = new InsufficientScopeError('Insufficient scope');
    expect(authRejectReason(error.toResponseObject())).toBe('insufficient_scope');
  });
});
