/**
 * get_links accepts an optional link_source filter beside link_type.
 * Omitting it keeps every provenance. No schema change.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { Link } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('gls-a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '', frontmatter: {} });
  await engine.putPage('gls-b', { type: 'note', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: {} });
  await engine.putPage('gls-c', { type: 'note', title: 'C', compiled_truth: 'c', timeline: '', frontmatter: {} });
  await engine.addLink('gls-a', 'gls-b', '', 'cites', 'manual');
  await engine.addLink('gls-a', 'gls-b', '', 'cites', 'cap-sync');
  await engine.addLink('gls-a', 'gls-c', '', 'related_to', 'manual');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function ctx(): OperationContext {
  return {
    engine,
    remote: false,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
  } as unknown as OperationContext;
}

function rows(params: Record<string, unknown>): Promise<Link[]> {
  return operationsByName['get_links'].handler(ctx(), { slug: 'gls-a', ...params }) as Promise<Link[]>;
}

function edge(l: Link): string {
  return `${l.to_slug}:${l.link_type}:${l.link_source}`;
}

describe('get_links link_source filter', () => {
  test('the parameter is optional on get_links and absent on get_backlinks', () => {
    const linkSourceParam = operationsByName['get_links'].params.link_source;
    expect(linkSourceParam).toMatchObject({ type: 'string' });
    expect(linkSourceParam?.required).toBeUndefined();
    expect(operationsByName['get_backlinks'].params.link_source).toBeUndefined();
  });

  test('omitting link_source keeps every provenance', async () => {
    const got = (await rows({})).map(edge).sort();
    expect(got).toEqual([
      'gls-b:cites:cap-sync',
      'gls-b:cites:manual',
      'gls-c:related_to:manual',
    ]);
  });

  test('link_source returns only that provenance', async () => {
    expect((await rows({ link_source: 'manual' })).map(edge).sort()).toEqual([
      'gls-b:cites:manual',
      'gls-c:related_to:manual',
    ]);
    expect((await rows({ link_source: 'cap-sync' })).map(edge)).toEqual(['gls-b:cites:cap-sync']);
  });

  test('link_source and link_type filter together', async () => {
    expect((await rows({ link_type: 'cites', link_source: 'manual' })).map(edge)).toEqual(['gls-b:cites:manual']);
  });

  test('a blank link_source keeps the current list', async () => {
    const all = (await rows({})).map(edge).sort();
    expect((await rows({ link_source: '' })).map(edge).sort()).toEqual(all);
  });
});
