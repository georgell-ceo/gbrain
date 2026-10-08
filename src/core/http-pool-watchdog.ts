/**
 * Hosted HTTP pool watchdog.
 *
 * A starved client pool raises no exception and the event loop stays alive,
 * so a host restart policy that waits for process exit never fires. This
 * probe reuses `runDbReadinessProbe`. After sustained `pool_starved` or
 * `unknown` verdicts it exits synchronously (status 70) so the host can
 * restart the process.
 *
 * Hard off: `GBRAIN_HTTP_POOL_WATCHDOG_MS=0` or `GBRAIN_HTTP_FATAL_EXIT=0`.
 * `client_misconfigured` does not exit (a restart will not fix the config).
 * `server_unreachable` uses three times the fail limit so a brief network
 * blip does not restart the process. A read-pool success whose direct lane
 * failed (`directUnready`) uses that same slower budget: the read pool can
 * still serve, so it is not treated as client-pool starvation.
 * Each miss short of the limit is logged. A tick still in flight is not
 * started again, and a tick that finishes after stop does not exit.
 */
import {
  DIRECT_PROBE_TIMEOUT_MS,
  getConnectionRouting,
  runDbReadinessProbe,
  type DbProbeResult,
  type PoolDiagnostics,
} from './minions/db-probe.ts';

export const HTTP_POOL_WATCHDOG_DEFAULTS = {
  everyMs: 15_000,
  maxFails: 4,
  graceMs: 60_000,
  probeTimeoutMs: 5_000,
} as const;

/** Distinct from the fatal-handler exit (1) so operators can tell the two apart. */
export const HTTP_POOL_STARVATION_EXIT = 70;

export interface HttpPoolWatchdogEngine {
  readonly kind: string;
  executeRaw(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<unknown>;
  executeRawDirect?(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<unknown>;
  getPoolDiagnostics?(): PoolDiagnostics | null;
  connectionManager?: { isDualPoolActive?: () => boolean };
}

type Warn = (msg: string) => void;

function parseNonNegative(name: string, raw: string | undefined, fallback: number, warn: Warn): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    warn(`[serve-http] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

export interface HttpPoolWatchdogConfig {
  everyMs: number;
  maxFails: number;
  fatalExit: boolean;
}

export function resolveHttpPoolWatchdogConfig(
  env: Record<string, string | undefined> = process.env,
  warn: Warn = (msg) => { console.error(msg); },
): HttpPoolWatchdogConfig {
  const everyMs = parseNonNegative(
    'GBRAIN_HTTP_POOL_WATCHDOG_MS',
    env.GBRAIN_HTTP_POOL_WATCHDOG_MS,
    HTTP_POOL_WATCHDOG_DEFAULTS.everyMs,
    warn,
  );
  let maxFails = parseNonNegative(
    'GBRAIN_HTTP_POOL_WATCHDOG_FAILS',
    env.GBRAIN_HTTP_POOL_WATCHDOG_FAILS,
    HTTP_POOL_WATCHDOG_DEFAULTS.maxFails,
    warn,
  );
  if (maxFails < 1) {
    warn(`[serve-http] GBRAIN_HTTP_POOL_WATCHDOG_FAILS must be >= 1; using ${HTTP_POOL_WATCHDOG_DEFAULTS.maxFails}`);
    maxFails = HTTP_POOL_WATCHDOG_DEFAULTS.maxFails;
  }
  const fatalExit = env.GBRAIN_HTTP_FATAL_EXIT !== '0';
  return { everyMs, maxFails, fatalExit };
}

export interface HttpPoolWatchdogHandle {
  /** One probe. Tests call this directly; `start` calls it on the interval. */
  tick(): Promise<void>;
  /** Begin the interval. No-op when the watchdog is off. Returns stop. */
  start(): () => void;
  /** `off`, or `<ms>ms fails=<n>` when the interval will run. */
  label: string;
}

export interface HttpPoolWatchdogOptions {
  env?: Record<string, string | undefined>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  now?: () => number;
  graceMs?: number;
  fatalExit?: boolean;
  everyMs?: number;
  maxFails?: number;
  probe?: () => Promise<DbProbeResult>;
  warn?: Warn;
}

function defaultProbe(engine: HttpPoolWatchdogEngine): Promise<DbProbeResult> {
  const routing = getConnectionRouting(engine);
  return runDbReadinessProbe({
    probeRead: async signal => { await engine.executeRaw('SELECT 1', [], { signal }); },
    probeDirect: routing?.isDualPoolActive?.()
      ? async signal => { await engine.executeRawDirect!('SELECT 1', [], { signal }); }
      : undefined,
    getDiagnostics: engine.getPoolDiagnostics ? () => engine.getPoolDiagnostics!() ?? null : undefined,
    timeoutMs: HTTP_POOL_WATCHDOG_DEFAULTS.probeTimeoutMs,
    directTimeoutMs: DIRECT_PROBE_TIMEOUT_MS,
  });
}

export function createHttpPoolWatchdog(
  engine: HttpPoolWatchdogEngine | undefined,
  opts: HttpPoolWatchdogOptions = {},
): HttpPoolWatchdogHandle {
  const env = opts.env ?? process.env;
  const resolved = resolveHttpPoolWatchdogConfig(env, opts.warn);
  const everyMs = opts.everyMs ?? resolved.everyMs;
  const maxFails = opts.maxFails ?? resolved.maxFails;
  const fatalExit = opts.fatalExit ?? resolved.fatalExit;
  const enabled = !!engine && engine.kind === 'postgres' && everyMs > 0 && fatalExit;
  const label = enabled ? `${everyMs}ms fails=${maxFails}` : 'off';
  if (!enabled || !engine) {
    return { label, tick: async () => {}, start: () => () => {} };
  }

  const exit = opts.exit ?? ((code: number) => { process.exit(code); });
  const log = opts.log ?? ((line: string) => { console.error(line); });
  const now = opts.now ?? (() => Date.now());
  const graceMs = opts.graceMs ?? HTTP_POOL_WATCHDOG_DEFAULTS.graceMs;
  const probe = opts.probe ?? (() => defaultProbe(engine));
  const startedAt = now();
  let fails = 0;
  let unreachable = 0;
  let exited = false;
  let inflight = false;
  let stopped = false;

  function slowBudget(result: DbProbeResult): boolean {
    if (result.ok || result.verdict === 'client_misconfigured') return false;
    if (result.verdict === 'server_unreachable') return true;
    return result.verdict === 'unknown' && result.directUnready === true;
  }

  async function tick(): Promise<void> {
    if (exited || stopped) return;
    if (now() - startedAt < graceMs) return;
    let result: DbProbeResult;
    try {
      result = await probe();
    } catch (err) {
      result = {
        ok: false,
        verdict: 'unknown',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (exited || stopped) return;
    if (result.ok) {
      fails = 0;
      unreachable = 0;
      return;
    }
    if (result.verdict === 'client_misconfigured') return;
    if (slowBudget(result)) {
      unreachable++;
      fails = 0;
      const limit = maxFails * 3;
      if (unreachable >= limit) die(result.verdict);
      else note(result.verdict, unreachable, limit);
      return;
    }
    unreachable = 0;
    fails++;
    if (fails >= maxFails) die(result.verdict);
    else note(result.verdict, fails, maxFails);
  }

  function note(verdict: string, n: number, limit: number): void {
    log(`[hosted-http] pool watchdog miss (${verdict}) ${n}/${limit}`);
  }

  function die(verdict: string): void {
    if (exited || stopped) return;
    exited = true;
    log(`[hosted-http] fatal pool starvation (${verdict}); exiting so the host can restart`);
    exit(HTTP_POOL_STARVATION_EXIT);
  }

  return {
    label,
    tick,
    start() {
      const timer = setInterval(() => {
        if (inflight || stopped) return;
        inflight = true;
        void tick()
          .catch((err) => {
            log(`[hosted-http] pool watchdog probe failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => { inflight = false; });
      }, everyMs);
      timer.unref?.();
      return () => { stopped = true; clearInterval(timer); };
    },
  };
}
