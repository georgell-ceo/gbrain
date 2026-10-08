import type { Request, RequestHandler, Response } from 'express';
import {
  authRejectLogLine,
  authRejectRateKey,
  authRejectReason,
  authRejectSourceIp,
  createAuthRejectLimiter,
  currentAuthRejectClient,
  runWithAuthRejectHint,
  truncateUserAgent,
  type AuthRejectLimiter,
} from '../core/mcp-auth-reject-log.ts';

const sharedLimiter = createAuthRejectLimiter();

export interface McpAuthRejectLogOptions {
  now?: () => number;
  warn?: (line: string) => void;
  limiter?: AuthRejectLimiter;
}

/**
 * Wrap the MCP bearer middleware. A 401 or 403 from that middleware writes
 * at most one warning a minute per reason, source address and user agent.
 * Logging never reads the Authorization header.
 */
export function withMcpAuthRejectLog(middleware: RequestHandler, options: McpAuthRejectLogOptions = {}): RequestHandler {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const limiter = options.limiter ?? sharedLimiter;
  return (req, res, next) => runWithAuthRejectHint(() => {
    const originalJson = res.json;
    const originalStatus = res.status;
    let statusCode = res.statusCode;
    res.status = function (this: Response, code: number) {
      statusCode = code;
      return originalStatus.call(this, code);
    } as typeof res.status;
    res.json = function (this: Response, body?: unknown) {
      if (statusCode === 401 || statusCode === 403) {
        try { writeAuthReject(req, body, now(), warn, limiter); }
        catch { /* a log failure must not change the rejection */ }
      }
      return originalJson.call(this, body);
    } as typeof res.json;
    const restore = () => {
      res.json = originalJson;
      res.status = originalStatus;
    };
    try {
      const result = middleware(req, res, next);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).finally(restore);
      }
      restore();
      return result;
    } catch (err) {
      restore();
      throw err;
    }
  });
}

function writeAuthReject(
  req: Request,
  body: unknown,
  now: number,
  warn: (line: string) => void,
  limiter: AuthRejectLimiter,
): void {
  const reason = authRejectReason(body);
  const method = cleanMethod(req.method);
  const path = cleanPath(req.path || req.url || '/');
  const userAgent = truncateUserAgent(req.headers['user-agent']);
  const ip = authRejectSourceIp(req.headers['x-forwarded-for'], req.ip || req.socket?.remoteAddress);
  const decision = limiter.decide(authRejectRateKey(reason, ip, userAgent), now);
  if (!decision.emit) return;
  warn(authRejectLogLine({
    reason,
    method,
    path,
    userAgent,
    ip,
    clientId: currentAuthRejectClient(),
    suppressed: decision.suppressed,
  }));
}

function cleanMethod(method: string | undefined): string {
  const text = (method ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return text.slice(0, 16) || 'UNKNOWN';
}

function cleanPath(path: string): string {
  const pathname = path.split('?')[0]?.split('#')[0] ?? '/';
  const cleaned = pathname.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned) || '/';
}
