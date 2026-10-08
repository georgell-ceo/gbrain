/**
 * An unreadable embedding-settings or catalog read is retried once, then
 * fails as facts_embedding_unreadable. A read that returns concrete values
 * that differ keeps embedding_configuration, with no retry.
 */
import { expect, test } from 'bun:test';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { codeRetryable } from '../src/core/error-catalogue.ts';
import type { FactEmbeddingSignature } from '../src/core/facts/extract.ts';
import { DETERMINISTIC_WRITE_REFUSALS, writeFactsAbsorbFailure } from '../src/core/facts/absorb-log.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { assertManagedFactsEmbedding, resolveManagedFactsEmbedding } from '../src/core/persistence/facts-maintenance.ts';

const CONFIG = { engine: 'postgres' } as GBrainConfig;
const VOYAGE: FactEmbeddingSignature = { model: 'voyage:voyage-4', dimensions: 1024 };
const GOOD_CONFIG = [
  { key: 'embedding_dimensions', value: '1024' },
  { key: 'embedding_disabled', value: 'false' },
  { key: 'embedding_model', value: 'voyage:voyage-4' },
];
const OTHER_CONFIG = [
  { key: 'embedding_dimensions', value: '1024' },
  { key: 'embedding_disabled', value: 'false' },
  { key: 'embedding_model', value: 'openai:text-embedding-3-large' },
];

type QueryKind = 'config' | 'catalog-exists' | 'catalog-type';

function queryKind(sql: string): QueryKind {
  if (sql.includes('FROM config')) return 'config';
  if (sql.includes('information_schema')) return 'catalog-exists';
  if (sql.includes('format_type')) return 'catalog-type';
  throw new Error(`unexpected sql: ${sql}`);
}

function scriptedEngine(next: (kind: QueryKind, n: number) => { rows?: unknown[]; error?: unknown }) {
  const calls: QueryKind[] = [];
  const seen: Record<QueryKind, number> = { config: 0, 'catalog-exists': 0, 'catalog-type': 0 };
  const sqls: string[] = [];
  const engine = {
    calls,
    sqls,
    async executeRaw(sql: string) {
      const kind = queryKind(sql);
      calls.push(kind);
      sqls.push(sql);
      seen[kind] += 1;
      const reply = next(kind, seen[kind]);
      if (reply.error) throw reply.error;
      return reply.rows ?? [];
    },
  };
  return engine;
}

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const column = (formatted: string) => (kind: QueryKind) => {
  if (kind === 'catalog-exists') return { rows: [{ exists: true }] };
  if (kind === 'catalog-type') return { rows: [{ formatted }] };
  return { rows: GOOD_CONFIG };
};

async function withWarns<T>(fn: () => Promise<T>): Promise<{ value: T; warns: string[] }> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), warns };
  } finally {
    console.warn = orig;
  }
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the embedding check to throw');
}

test('an empty settings read is retried once and then admits', async () => {
  const engine = scriptedEngine((kind, n) => kind === 'config' && n === 1 ? { rows: [] } : column('halfvec(1024)')(kind));
  const { warns } = await withWarns(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE));
  expect(engine.calls.filter(kind => kind === 'config')).toEqual(['config', 'config']);
  expect(engine.calls.filter(kind => kind === 'catalog-exists')).toHaveLength(1);
  expect(warns.some(line => line.includes('unreadable config') && line.includes('config query returned no rows'))).toBe(true);
});

test('a cancelled settings read is retried once on the same handle and then admits', async () => {
  const engine = scriptedEngine((kind, n) => kind === 'config' && n === 1
    ? { error: pgError('canceling statement due to user request', '57014') }
    : column('halfvec(1024)')(kind));
  await assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE, true);
  expect(engine.calls.filter(kind => kind === 'config')).toHaveLength(2);
  expect(engine.sqls.filter(sql => sql.includes('FROM config')).every(sql => sql.includes('FOR SHARE'))).toBe(true);
});

test('a missing facts vector column is retried once and then admits', async () => {
  const engine = scriptedEngine((kind, n) => {
    if (kind === 'config') return { rows: GOOD_CONFIG };
    if (kind === 'catalog-exists' && n === 1) return { rows: [{ exists: false }] };
    return column('halfvec(1024)')(kind);
  });
  const signature = await resolveManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG);
  expect(signature).toEqual(VOYAGE);
  expect(engine.calls.filter(kind => kind === 'catalog-exists')).toHaveLength(2);
  expect(engine.calls.filter(kind => kind === 'config')).toHaveLength(2);
});

test('two empty settings reads fail as a transient error and log the miss', async () => {
  const engine = scriptedEngine(() => ({ rows: [] }));
  const { value, warns } = await withWarns(async () => catchError(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE)));
  expect(value).toBeInstanceOf(OperationError);
  const error = value as OperationError;
  expect(error.code).toBe('facts_embedding_unreadable');
  expect(error.code).not.toBe('embedding_configuration');
  expect(error.message).toContain('Try again later');
  expect(error.message).toContain('same request_id is safe');
  expect(engine.calls).toEqual(['config', 'config']);
  expect(warns.filter(line => line.includes('unreadable config') && line.includes('config query returned no rows'))).toHaveLength(2);
});

test('two cancelled reads fail as a transient error and log the underlying error', async () => {
  const message = 'canceling statement due to user request (reader-settled-7f3a) postgres://db.example/gbrain';
  const engine = scriptedEngine(() => ({ error: pgError(message, '57014') }));
  const logged: string[] = [];
  const { value, warns } = await withWarns(async () => catchError(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE)));
  expect(value).toBeInstanceOf(OperationError);
  const error = value as OperationError;
  expect(error.code).toBe('facts_embedding_unreadable');
  expect(error.message).not.toContain('provenance does not match');
  expect(engine.calls).toEqual(['config', 'config']);
  const text = warns.join('\n');
  expect(text).toContain('reader-settled-7f3a');
  expect(text).toContain('SQLSTATE 57014');
  expect(text).toContain('unreadable config');
  expect(text).toContain('[redacted-url]');
  expect(text).not.toContain('postgres://db.example/gbrain');
  expect(warns.filter(line => line.includes('unreadable config'))).toHaveLength(2);
  await writeFactsAbsorbFailure({
    async logIngest(entry: { summary: string }) { logged.push(entry.summary); },
  } as unknown as BrainEngine, 'notes/page-day', error);
  expect(logged).toEqual([
    `write_refused: facts_embedding_unreadable (OperationError): ${error.message}`,
  ]);
  expect(logged.join('\n')).not.toContain('embedding_configuration');
});

test('two unreadable catalog reads fail as a transient error, not a provenance mismatch', async () => {
  const engine = scriptedEngine(kind => kind === 'config' ? { rows: GOOD_CONFIG } : { rows: [{ exists: false }] });
  const error = await catchError(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE)) as OperationError;
  expect(error).toBeInstanceOf(OperationError);
  expect(error.code).toBe('facts_embedding_unreadable');
  expect(error.message).not.toContain('provenance does not match');
  expect(engine.calls.filter(kind => kind === 'config')).toHaveLength(2);
  expect(engine.calls.filter(kind => kind === 'catalog-exists')).toHaveLength(2);
  expect(engine.calls).not.toContain('catalog-type');
});

test('a real width mismatch stays embedding_configuration and is not retried', async () => {
  const engine = scriptedEngine(column('halfvec(1280)'));
  const { value, warns } = await withWarns(async () => catchError(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE)));
  const error = value as OperationError;
  expect(error).toBeInstanceOf(OperationError);
  expect(error.code).toBe('embedding_configuration');
  expect(error.message).toContain('provenance does not match');
  expect(engine.calls.filter(kind => kind === 'config')).toHaveLength(1);
  expect(engine.calls).toEqual(['config', 'catalog-exists', 'catalog-type']);
  expect(warns.some(line => line.includes('mismatch catalog') && line.includes('1280') && line.includes('1024'))).toBe(true);
  expect(warns.some(line => line.includes('unreadable'))).toBe(false);
});

test('a real model change stays embedding_configuration and is not retried', async () => {
  const engine = scriptedEngine(kind => kind === 'config' ? { rows: OTHER_CONFIG } : column('halfvec(1024)')(kind));
  const { value, warns } = await withWarns(async () => catchError(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE)));
  const error = value as OperationError;
  expect(error).toBeInstanceOf(OperationError);
  expect(error.code).toBe('embedding_configuration');
  expect(error.message).toContain('policy or model changed');
  expect(engine.calls.filter(kind => kind === 'config')).toHaveLength(1);
  expect(warns.some(line => line.includes('mismatch config') && line.includes('voyage:voyage-4') && line.includes('openai:text-embedding-3-large'))).toBe(true);
  expect(warns.some(line => line.includes('unreadable'))).toBe(false);
});

test('an aborted transaction is not retried on the same handle', async () => {
  const engine = scriptedEngine(() => ({
    error: pgError('current transaction is aborted, commands ignored until end of transaction block', '25P02'),
  }));
  const started = Date.now();
  const error = await catchError(() => assertManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG, VOYAGE, true)) as OperationError;
  expect(Date.now() - started).toBeLessThan(200);
  expect(error).toBeInstanceOf(OperationError);
  expect(error.code).toBe('facts_embedding_unreadable');
  expect(error.code).not.toBe('embedding_configuration');
  expect(engine.calls).toEqual(['config']);
  expect(engine.sqls[0]).toContain('FOR SHARE');
});

test('facts_embedding_unreadable is retryable and is not a deterministic write refusal', () => {
  expect(codeRetryable('facts_embedding_unreadable')).toBe(true);
  expect(codeRetryable('embedding_configuration')).toBe(false);
  expect(DETERMINISTIC_WRITE_REFUSALS).not.toContain('facts_embedding_unreadable');
});

test('no recorded model still means embeddings are off, with no retry', async () => {
  const engine = scriptedEngine(() => ({ rows: [] }));
  const signature = await resolveManagedFactsEmbedding(engine as unknown as BrainEngine, CONFIG);
  expect(signature).toBeNull();
  expect(engine.calls).toEqual(['config']);
});
