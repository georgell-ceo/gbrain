import { LocalConfigurationError } from '../minions/configuration-error.ts';

export function hasPostgresCancellationCapability(owner: unknown): boolean {
  return typeof (owner as { discard?: unknown } | null)?.discard === 'function';
}

export function postgresCancellationUnavailable(): LocalConfigurationError {
  return new LocalConfigurationError(
    'postgres_cancellation_unavailable',
    'The installed Postgres driver lacks safe cancellation support (discard). ' +
    'Repair this installation, then restart the worker: reinstall the current GBrain package ' +
    '(global: bun install -g github:garrytan/gbrain; checkout: bun install; compiled: replace with the current release). ' +
    'See docs/guides/minions-fix.md#postgres-cancellation-unavailable.',
  );
}

export async function reserveWithCancellation<T extends { release(): void }>(
  reserve: (opts: { signal: AbortSignal }) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  let abandoned = false;
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      abandoned = true;
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const reserving = reserve({ signal }).then(owner => {
      if (abandoned) {
        owner.release();
        throw new DOMException('aborted', 'AbortError');
      }
      return owner;
    });
    return await Promise.race([reserving, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Default bound for post-abort cancel and the in-flight statement. `0` discards on the next turn. */
export const DEFAULT_ABORT_CANCEL_MS = 5_000;

export function resolveAbortCancelMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_HTTP_ABORT_CANCEL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ABORT_CANCEL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ABORT_CANCEL_MS;
  return Math.floor(n);
}

interface CancellablePending extends Promise<unknown> {
  cancel?: () => Promise<unknown>;
}

interface Discardable {
  discard?: () => void;
}

interface UnsafeConn extends Discardable {
  // Method syntax (bivariant params) so postgres.js `unsafe` stays assignable.
  unsafe(sql: string, params?: unknown[], opts?: object): CancellablePending;
  reserve?(opts: { signal: AbortSignal }): Promise<ReservedConn>;
}

interface ReservedConn extends UnsafeConn {
  release(): void;
}

export interface AbortSettleState {
  cancellation?: Promise<unknown>;
  pending?: Promise<unknown>;
  retired: boolean;
  /** Deadline already elapsed while the statement was still in flight. */
  forceDiscard?: boolean;
  owner: Discardable;
  reserved?: { release?: () => void };
  deadlineMs: number;
}

function observe(p: Promise<unknown> | undefined): void {
  p?.then(() => {}, () => {});
}

/**
 * After an abort, wait for cancel and the statement only until `deadlineMs`.
 * A deadline discards the reserved connection so the pool slot returns even
 * when the cancellation transport never closes. Late rejections stay observed.
 */
export async function finishAbortedUnsafe(state: AbortSettleState): Promise<void> {
  try {
    if (state.forceDiscard) {
      observe(state.cancellation);
      observe(state.pending);
      state.owner.discard?.();
      return;
    }
    if (state.cancellation) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), state.deadlineMs);
      });
      const settled = state.cancellation.then(() => 'settled' as const, () => 'settled' as const);
      const winner = await Promise.race([settled, deadline]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner === 'deadline') {
        state.retired = true;
        observe(state.cancellation);
        observe(state.pending);
      }
    }
    if (state.retired) state.owner.discard?.();
  } finally {
    state.reserved?.release?.();
  }
}

async function awaitPendingOrAbortDeadline<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  ms: number,
  onDeadline: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      onDeadline();
      rejectDeadline(new DOMException('aborted', 'AbortError'));
    }, ms);
  };
  let rejectDeadline: (err: unknown) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    if (signal.aborted) arm();
    else signal.addEventListener('abort', arm, { once: true });
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', arm);
    observe(pending);
  }
}

/**
 * Shared body for executeRaw / executeRawDirect. Pre-aborted signals throw
 * synchronously, before any reservation. A signalled statement keeps its
 * reserved connection until cancel settles or `GBRAIN_HTTP_ABORT_CANCEL_MS`.
 */
export function runCancellableUnsafe<T>(
  conn: UnsafeConn,
  sql: string,
  params: unknown[] | undefined,
  opts: { signal?: AbortSignal; prepare?: boolean; simple?: boolean } | undefined,
  onReserved: () => void,
): Promise<T[]> {
  if (opts?.signal?.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  return (async () => {
    const signal = opts?.signal;
    const deadlineMs = resolveAbortCancelMs();
    let reserved: ReservedConn | undefined;
    let pending: CancellablePending | undefined;
    let cancellation: Promise<unknown> | undefined;
    let retired = false;
    let forceDiscard = false;
    let owner: Discardable = conn;
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      reserved = signal && typeof conn.reserve === 'function'
        ? await reserveWithCancellation(reserveOpts => conn.reserve!(reserveOpts), signal)
        : undefined;
      if (reserved) { conn = reserved; onReserved(); }
      owner = reserved ?? conn;
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (signal && !hasPostgresCancellationCapability(owner)) throw postgresCancellationUnavailable();
      const driverOpts = {
        cancelFence: !!signal,
        prepare: opts?.prepare ?? true,
        ...(opts?.simple === undefined ? {} : { simple: opts.simple }),
      };
      pending = conn.unsafe(sql, params, driverOpts);
      if (!signal) return await pending as unknown as T[];
      return await awaitPendingOrAbortDeadline(pending as unknown as Promise<T[]>, signal, deadlineMs, () => { forceDiscard = true; });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await finishAbortedUnsafe({ cancellation, pending, retired, forceDiscard, owner, reserved, deadlineMs });
    }
    function onAbort() {
      if (!pending || cancellation) return;
      try { cancellation = pending.cancel?.().catch(() => { retired = true; }); }
      catch { retired = true; }
    }
  })();
}
