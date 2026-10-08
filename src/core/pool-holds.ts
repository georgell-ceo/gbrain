/**
 * Who holds a pooled Postgres connection, recorded when the connection leaves
 * the idle queue. The pool-starved exit reads this once. It is not a tracer:
 * one owner string at acquire, and the last statement text when a statement
 * is sent. Parameter values are never stored.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const owners = new AsyncLocalStorage<string>();

const SQL_MAX = 180;

export interface PoolCensus {
  max: number;
  idle: number;
  in_use: number;
  waiting: number;
}

interface Hold {
  pool: string;
  id: number;
  holder: string;
  acquiredAt: number;
  lastSql: string;
}

export interface PoolHoldView {
  pool: string;
  id: number;
  holder: string;
  age_ms: number;
  last_sql: string;
}

const holds = new Map<string, Hold>();
const pendingSql = new Map<string, string>();

function key(pool: string, id: number): string {
  return `${pool}:${id}`;
}

/** Keep owner labels to a single log token. */
export function sanitizePoolOwner(raw: string): string {
  const cleaned = raw.replace(/[^\w.:-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 96);
  return cleaned || 'unknown';
}

export function withPoolOwner<T>(owner: string, fn: () => T): T {
  return owners.run(sanitizePoolOwner(owner), fn);
}

export function mcpPoolOwner(requestId: unknown, toolName: unknown): string {
  const tool = sanitizePoolOwner(typeof toolName === 'string' && toolName ? toolName : 'unknown');
  const id = requestId == null || requestId === '' ? '' : sanitizePoolOwner(String(requestId));
  return id ? `mcp:${id}:${tool}` : `mcp:${tool}`;
}

export function jobPoolOwner(name: string): string {
  const token = sanitizePoolOwner(name);
  return token === 'autopilot' || token.startsWith('autopilot-') || token.startsWith('autopilot_')
    ? `autopilot:${token}`
    : `job:${token}`;
}

/** Statement text only. Placeholders stay; values, URLs and assigned secrets do not. */
export function redactStatement(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (!flat) return 'none';
  const redacted = flat
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
    .replace(/\b(password|secret|token|api_key)\s*=\s*'(?:[^']|'')*'/gi, "$1='[redacted]'")
    .replace(/\b(password|secret|token|api_key)\s*=\s*"[^"]*"/gi, '$1="[redacted]"');
  return redacted.length > SQL_MAX ? `${redacted.slice(0, SQL_MAX)}...` : redacted;
}

export function notePoolHold(pool: string, id: number, event: 'acquire' | 'release'): void {
  const slot = key(pool, id);
  if (event === 'release') {
    holds.delete(slot);
    pendingSql.delete(slot);
    return;
  }
  const pending = pendingSql.get(slot);
  pendingSql.delete(slot);
  holds.set(slot, {
    pool,
    id,
    holder: owners.getStore() ?? 'unknown',
    acquiredAt: Date.now(),
    lastSql: pending ?? 'none',
  });
}

export function notePoolSql(pool: string, id: number, sql: string): void {
  const text = redactStatement(sql);
  const slot = key(pool, id);
  const hold = holds.get(slot);
  if (hold) hold.lastSql = text;
  else pendingSql.set(slot, text);
}

export function poolHoldSnapshot(now = Date.now()): PoolHoldView[] {
  return [...holds.values()]
    .map(hold => ({
      pool: hold.pool,
      id: hold.id,
      holder: hold.holder,
      age_ms: Math.max(0, now - hold.acquiredAt),
      last_sql: hold.lastSql,
    }))
    .sort((a, b) => b.age_ms - a.age_ms || a.id - b.id);
}

export function resetPoolHoldsForTests(): void {
  holds.clear();
  pendingSql.clear();
}

export function readPoolCensus(sql: unknown): PoolCensus | null {
  const fn = (sql as { poolCensus?: () => PoolCensus } | null)?.poolCensus;
  if (typeof fn !== 'function') return null;
  const census = fn();
  if (!census || typeof census.max !== 'number') return null;
  return {
    max: census.max,
    idle: census.idle,
    in_use: census.in_use,
    waiting: census.waiting,
  };
}

export function formatPoolStarvationLine(census: PoolCensus | null, held: PoolHoldView[]): string {
  return `[hosted-http] pool_starved holders ${JSON.stringify({
    size: census?.max ?? null,
    in_use: census?.in_use ?? null,
    idle: census?.idle ?? null,
    waiting: census?.waiting ?? null,
    holds: held.map(hold => ({
      pool: hold.pool,
      id: hold.id,
      holder: hold.holder,
      age_ms: hold.age_ms,
      last_sql: hold.last_sql,
    })),
  })}`;
}

type HoldHook = (id: number, event: 'acquire' | 'release') => void;
type SqlHook = (id: number, sql: string) => void;

/** Adds the acquire and last-statement hooks. Does not wrap sockets or copy parameters. */
export function withPoolHoldHooks<T extends Record<string, unknown>>(options: T, pool: string): T {
  const previousHold = options.onhold;
  const previousSql = options.onsql;
  const onhold: HoldHook = (id, event) => {
    try { notePoolHold(pool, id, event); } catch { /* a diagnostic must not fail the query */ }
    if (typeof previousHold === 'function') (previousHold as HoldHook)(id, event);
  };
  const onsql: SqlHook = (id, sql) => {
    try { notePoolSql(pool, id, sql); } catch { /* a diagnostic must not fail the query */ }
    if (typeof previousSql === 'function') (previousSql as SqlHook)(id, sql);
  };
  return { ...options, onhold, onsql };
}
