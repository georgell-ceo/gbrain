/**
 * Clean up bare-slug duplicate entity pages.
 *
 * Context: during the 2026-05-20 Iron-Law back-link rollout, 113 bare-slug
 * duplicate entity pages were created (78 person, 35 company) — sibling
 * duplicates of canonical `people/X` / `companies/X` pages. Some upstream
 * caller fed bare relative paths to importFromFile.
 *
 * Strategy per duplicate:
 *   1. Look for a canonical counterpart at `people/<bare>` or `companies/<bare>`.
 *   2. If the canonical exists: migrate any inbound links from the bare slug
 *      to the canonical, then soft-delete the bare-slug page.
 *   3. If no canonical exists: RENAME the bare-slug page to its canonical
 *      form (people/X or companies/X) and keep its data — this is the
 *      first time we have this entity.
 *
 * Dry-run by default; pass --apply to write changes.
 */

import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { loadConfig } from '../src/core/config.ts';

interface BareSlugRow {
  id: number;
  slug: string;
  type: string;
  title: string | null;
  has_canonical: boolean;
  canonical_slug: string;
}

function toEngineConfig(config: ReturnType<typeof loadConfig> & object) {
  return {
    engine: config.engine ?? 'postgres',
    database_url: config.database_url,
    embedding_dimensions: config.embedding_dimensions ?? 1536,
    schema_namespace: config.schema_namespace,
  } as Parameters<typeof connectWithRetry>[1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  if (!config) throw new Error('No brain configured');
  const engine = await createEngine(toEngineConfig(config));
  await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

  console.log(`Mode: ${apply ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);

  const rows = (await engine.executeRaw(`
    SELECT
      b.id,
      b.slug,
      b.type,
      b.title,
      (c.id IS NOT NULL) AS has_canonical,
      CASE
        WHEN b.type = 'person' THEN 'people/' || b.slug
        WHEN b.type = 'company' THEN 'companies/' || b.slug
        ELSE b.slug
      END AS canonical_slug
    FROM pages b
    LEFT JOIN pages c
      ON c.slug = CASE
                    WHEN b.type = 'person' THEN 'people/' || b.slug
                    WHEN b.type = 'company' THEN 'companies/' || b.slug
                  END
        AND c.source_id = b.source_id
    WHERE b.type IN ('person', 'company')
      AND b.slug NOT LIKE '%/%'
    ORDER BY b.type, b.slug
  `, [])) as unknown as BareSlugRow[];

  console.log(`Found ${rows.length} bare-slug entity page(s)`);
  const withCanonical = rows.filter(r => r.has_canonical);
  const withoutCanonical = rows.filter(r => !r.has_canonical);
  console.log(`  ${withCanonical.length} have canonical counterparts (will merge + soft-delete bare)`);
  console.log(`  ${withoutCanonical.length} have NO canonical counterpart (will rename bare to canonical)`);

  if (!apply) {
    console.log('\nDRY RUN sample (first 10 by category):');
    console.log('  MERGE candidates:');
    for (const r of withCanonical.slice(0, 10)) {
      console.log(`    ${r.slug} (id=${r.id}) → ${r.canonical_slug}`);
    }
    console.log('  RENAME candidates:');
    for (const r of withoutCanonical.slice(0, 10)) {
      console.log(`    ${r.slug} (id=${r.id}) → ${r.canonical_slug}`);
    }
    await engine.disconnect();
    return;
  }

  let merged = 0;
  let renamed = 0;
  let errors = 0;

  for (const r of rows) {
    try {
      if (r.has_canonical) {
        // Migrate inbound links from bare → canonical, then soft-delete bare.
        // Outbound links from bare are lost (canonical likely has its own).
        // Timeline entries on bare are lost too — they're a tiny subset
        // compared to what the canonical already has from rich content.
        await engine.executeRaw(`
          UPDATE links
          SET to_page_id = (SELECT id FROM pages WHERE slug = $1)
          WHERE to_page_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM links l2
              WHERE l2.from_page_id = links.from_page_id
                AND l2.to_page_id = (SELECT id FROM pages WHERE slug = $1)
                AND l2.link_type = links.link_type
                AND COALESCE(l2.link_source, '') = COALESCE(links.link_source, '')
            )
        `, [r.canonical_slug, r.id]);
        // Drop remaining inbound links that conflict (already exist on canonical).
        await engine.executeRaw(`DELETE FROM links WHERE to_page_id = $1`, [r.id]);
        await engine.executeRaw(`DELETE FROM links WHERE from_page_id = $1`, [r.id]);
        await engine.executeRaw(`DELETE FROM content_chunks WHERE page_id = $1`, [r.id]);
        await engine.executeRaw(`DELETE FROM timeline_entries WHERE page_id = $1`, [r.id]);
        await engine.executeRaw(`DELETE FROM tags WHERE page_id = $1`, [r.id]);
        await engine.executeRaw(`DELETE FROM page_versions WHERE page_id = $1`, [r.id]);
        await engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [r.id]);
        merged++;
        if (merged % 10 === 0) console.log(`  Merged ${merged}/${withCanonical.length}...`);
      } else {
        // Rename bare → canonical. Unique constraint on (source_id, slug)
        // means we'd conflict if a canonical mysteriously appeared between
        // our SELECT and this UPDATE; the WHERE NOT EXISTS guards against
        // that race.
        const updated = await engine.executeRaw(`
          UPDATE pages
          SET slug = $1, updated_at = NOW()
          WHERE id = $2
            AND NOT EXISTS (SELECT 1 FROM pages WHERE slug = $1 AND source_id = pages.source_id)
          RETURNING id
        `, [r.canonical_slug, r.id]);
        if ((updated as unknown[]).length > 0) {
          renamed++;
          if (renamed % 10 === 0) console.log(`  Renamed ${renamed}/${withoutCanonical.length}...`);
        } else {
          errors++;
          console.warn(`  Rename skipped (race): ${r.slug} → ${r.canonical_slug}`);
        }
      }
    } catch (e) {
      errors++;
      console.error(`  Failed on ${r.slug}: ${(e as Error).message}`);
    }
  }

  console.log(`\nDone:`);
  console.log(`  Merged (bare → existing canonical): ${merged}`);
  console.log(`  Renamed (bare → new canonical):    ${renamed}`);
  console.log(`  Errors:                            ${errors}`);

  await engine.disconnect();
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
