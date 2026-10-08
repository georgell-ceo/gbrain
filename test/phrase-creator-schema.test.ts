/**
 * phrase-creator is a bundled pack that extends gbrain-creator and adds
 * depends_on and owned_by by name only. add_link accepts both verbs.
 */
import { describe, expect, test } from 'bun:test';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { BUNDLED_PACK_NAMES } from '../src/core/schema-pack/bundled.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import { locateMutablePackFile, SchemaPackMutationError } from '../src/core/schema-pack/mutate.ts';
import { packDeclaresLinkType } from '../src/core/schema-pack/write-vocabulary.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

describe('bundled phrase-creator schema', () => {
  test('loads as a built-in pack that extends gbrain-creator', () => {
    expect(BUNDLED_PACK_NAMES).toContain('phrase-creator');
    const path = bundledPackPath('phrase-creator');
    expect(path).toBeTruthy();
    const child = loadPackFromFile(path!);
    expect(child.name).toBe('phrase-creator');
    expect(child.extends).toBe('gbrain-creator');
    expect(child.link_types).toEqual([{ name: 'depends_on' }, { name: 'owned_by' }]);
    expect(child.frontmatter_links.filter(link => link.link_type === 'depends_on' || link.link_type === 'owned_by')).toEqual([]);
  });

  test('inherits every gbrain-creator link type and adds the two new names only', async () => {
    const creator = await loadResolvedPackByName('gbrain-creator');
    const phrase = await loadResolvedPackByName('phrase-creator');
    const creatorNames = creator.manifest.link_types.map(link => link.name);
    const phraseNames = phrase.manifest.link_types.map(link => link.name);
    expect(creatorNames).toContain('related_to');
    for (const name of creatorNames) expect(phraseNames).toContain(name);
    expect(phraseNames.filter(name => !creatorNames.includes(name)).sort()).toEqual(['depends_on', 'owned_by']);
    for (const name of ['depends_on', 'owned_by']) {
      expect(phrase.manifest.link_types.find(link => link.name === name)).toEqual({ name });
      expect(packDeclaresLinkType(phrase, name)).toBe(true);
    }
    expect(phrase.manifest.frontmatter_links.filter(link => link.link_type === 'depends_on' || link.link_type === 'owned_by')).toEqual([]);
  });

  test('add_link validation accepts depends_on and owned_by', async () => {
    const addLink = operations.find(op => op.name === 'add_link')!;
    const engine = {
      getConfig: async (key: string) => key === 'schema_pack' ? 'phrase-creator' : undefined,
    } as unknown as BrainEngine;
    const ctx = {
      engine,
      config: { engine: 'pglite' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: true,
      remote: true,
      sourceId: 'default',
    } as unknown as OperationContext;
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      for (const linkType of ['depends_on', 'owned_by']) {
        const result = await addLink.handler(ctx, {
          from: 'notes/alice-example',
          to: 'notes/widget-example',
          link_type: linkType,
        });
        expect(result).toMatchObject({ dry_run: true, action: 'add_link', from: 'notes/alice-example', to: 'notes/widget-example' });
      }
      await expect(addLink.handler(ctx, {
        from: 'notes/alice-example',
        to: 'notes/widget-example',
        link_type: 'definitely_not_a_link_verb',
      })).rejects.toThrow(/link type 'definitely_not_a_link_verb' is not declared in active schema pack 'phrase-creator'/);
    });
  });

  test('the bundled pack cannot be mutated in place', () => {
    expect(() => locateMutablePackFile('phrase-creator')).toThrow(SchemaPackMutationError);
    try {
      locateMutablePackFile('phrase-creator');
    } catch (error) {
      expect((error as SchemaPackMutationError).code).toBe('PACK_READONLY');
    }
  });
});
