/**
 * Remote remove_link must name link_source. A trusted local call may omit it
 * and then deletes every provenance for the pair, with a warning. Engine
 * removeLink (derived links, mentions, effect links) is not this op.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext & { warns: string[] } {
  const warns: string[] = [];
  return {
    engine,
    remote: false,
    config: {},
    logger: { info() {}, warn(msg: string) { warns.push(msg); }, error() {} },
    dryRun: false,
    warns,
    ...overrides,
  } as unknown as OperationContext & { warns: string[] };
}

async function seed(from: string, to: string): Promise<void> {
  await engine.putPage(from, { type: 'note', title: from, compiled_truth: 'a', timeline: '', frontmatter: {} });
  await engine.putPage(to, { type: 'note', title: to, compiled_truth: 'b', timeline: '', frontmatter: {} });
  await engine.addLink(from, to, '', 'cites', 'manual');
  await engine.addLink(from, to, '', 'cites', 'cap-sync');
}

async function sources(from: string, to: string): Promise<string[]> {
  const links = await engine.getLinks(from);
  return links.filter(l => l.to_slug === to).map(l => l.link_source ?? '').sort();
}

describe('remove_link link_source for remote callers', () => {
  const op = () => operationsByName['remove_link'];

  test('a remote call without link_source is refused and deletes nothing', async () => {
    await seed('rmt-a', 'rmt-b');
    const ctx = makeCtx({ remote: true });
    await expect(op().handler(ctx, { from: 'rmt-a', to: 'rmt-b' })).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringMatching(/pass link_source/),
      suggestion: expect.stringMatching(/link_source/),
    });
    expect(await sources('rmt-a', 'rmt-b')).toEqual(['cap-sync', 'manual']);
    expect(ctx.warns).toEqual([]);
  });

  test('a blank or non-false remote flag is the same refusal', async () => {
    await seed('rmt-blank', 'rmt-blank-b');
    await expect(op().handler(makeCtx({ remote: true }), { from: 'rmt-blank', to: 'rmt-blank-b', link_source: '  ' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(op().handler(makeCtx({ remote: undefined as unknown as boolean }), { from: 'rmt-blank', to: 'rmt-blank-b' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect(await sources('rmt-blank', 'rmt-blank-b')).toEqual(['cap-sync', 'manual']);
  });

  test('a remote dry-run without link_source is refused', async () => {
    await seed('rmt-dry', 'rmt-dry-b');
    await expect(op().handler(makeCtx({ remote: true, dryRun: true }), { from: 'rmt-dry', to: 'rmt-dry-b' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect(await sources('rmt-dry', 'rmt-dry-b')).toEqual(['cap-sync', 'manual']);
  });

  test('a manual row and a cap-sync row survive each other\'s scoped removal', async () => {
    await seed('rmt-scope', 'rmt-scope-b');
    const remote = makeCtx({ remote: true });
    await op().handler(remote, { from: 'rmt-scope', to: 'rmt-scope-b', link_source: 'manual' });
    expect(await sources('rmt-scope', 'rmt-scope-b')).toEqual(['cap-sync']);
    expect(remote.warns).toEqual([]);
    await engine.addLink('rmt-scope', 'rmt-scope-b', '', 'cites', 'manual');
    await op().handler(makeCtx({ remote: true }), { from: 'rmt-scope', to: 'rmt-scope-b', link_source: 'cap-sync' });
    expect(await sources('rmt-scope', 'rmt-scope-b')).toEqual(['manual']);
  });

  test('the local path still deletes every provenance and warns when link_source is omitted', async () => {
    await seed('rmt-local', 'rmt-local-b');
    const ctx = makeCtx();
    const result = await op().handler(ctx, { from: 'rmt-local', to: 'rmt-local-b' });
    expect(result).toMatchObject({ status: 'ok', removed: 2 });
    expect(await sources('rmt-local', 'rmt-local-b')).toEqual([]);
    expect(ctx.warns).toEqual([
      '[gbrain] unlink without --link-source will delete rows from every link source for this pair. Pass --link-source <tag> to remove one provenance only.',
    ]);
  });

  test('a local link_type-only delete still removes every provenance of that type', async () => {
    await seed('rmt-type', 'rmt-type-b');
    await engine.addLink('rmt-type', 'rmt-type-b', '', 'related_to', 'manual');
    const ctx = makeCtx();
    await op().handler(ctx, { from: 'rmt-type', to: 'rmt-type-b', link_type: 'cites' });
    expect(await sources('rmt-type', 'rmt-type-b')).toEqual(['manual']);
    const left = (await engine.getLinks('rmt-type')).filter(l => l.to_slug === 'rmt-type-b');
    expect(left.map(l => l.link_type)).toEqual(['related_to']);
    expect(ctx.warns).toHaveLength(1);
  });

  test('a local call that names link_source does not warn and leaves the other row', async () => {
    await seed('rmt-named', 'rmt-named-b');
    const ctx = makeCtx();
    await op().handler(ctx, { from: 'rmt-named', to: 'rmt-named-b', link_source: 'cap-sync' });
    expect(await sources('rmt-named', 'rmt-named-b')).toEqual(['manual']);
    expect(ctx.warns).toEqual([]);
  });

  test('engine.removeLink without a provenance still deletes every row', async () => {
    await seed('rmt-engine', 'rmt-engine-b');
    const removed = await engine.removeLink('rmt-engine', 'rmt-engine-b');
    expect(removed).toBe(2);
    expect(await sources('rmt-engine', 'rmt-engine-b')).toEqual([]);
  });
});
