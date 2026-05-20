/**
 * gbrain backfill-backlinks - Iron-Law back-link backfill for existing pages.
 *
 * Walks pages in the brain, re-extracts entity refs, and calls the Iron-Law
 * back-link writer (src/core/back-link-writer.ts) on each. Use when:
 *
 *   - Upgrading from a pre-v0.34 brain (before put_page emitted back-links).
 *   - After fixing the fellow-collector / collector pipelines that previously
 *     wrote attendees as bare names instead of resolvable entity refs.
 *   - When the back-link writer is enhanced (e.g. scope widened beyond
 *     people/+companies/) and you want existing pages to benefit.
 *
 * Read-only on the source pages. Writes go to links + timeline_entries
 * tables via the canonical writer. Idempotent: re-running creates 0 new
 * edges/entries because the unique constraints on (from, to, type, source,
 * origin) and (page, date, summary) ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   gbrain backfill-backlinks                  # all inbound-signal types
 *   gbrain backfill-backlinks --type meeting   # specific type
 *   gbrain backfill-backlinks --limit 50       # first N pages
 *   gbrain backfill-backlinks --dry-run        # walk + count, no writes
 *   gbrain backfill-backlinks --json           # JSON output for scripts
 */

import type { BrainEngine } from '../core/engine.ts';
import type { PageType } from '../core/types.ts';
import { extractPageLinks, makeResolver } from '../core/link-extraction.ts';
import { writeBackLinks, type BackLinkResult } from '../core/back-link-writer.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface BackfillStats {
  pages_walked: number;
  pages_with_entity_refs: number;
  edges_created: number;
  timeline_created: number;
  skipped: number;
  errors: number;
  per_type: Record<string, { walked: number; edges_created: number; timeline_created: number }>;
}

const DEFAULT_TYPES = ['meeting', 'source', 'transcript', 'note'];

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i === args.length - 1) return undefined;
  return args[i + 1];
}

export async function runBackfillBacklinks(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const typeFilter = parseArg(args, '--type');
  const limit = parseArg(args, '--limit');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`Usage: gbrain backfill-backlinks [options]

Iron-Law back-link backfill: walks pages in the brain and creates
'mentioned_in' edges + timeline entries on each referenced person/company.

Options:
  --type <kind>     Only process pages of this type. Default: meeting,source,transcript,note
  --limit <N>       Stop after N pages
  --dry-run         Walk + count without writing (safe preview)
  --json            JSON output
  --help, -h        Show this help
`);
    return;
  }

  const limitN = limit ? parseInt(limit, 10) : undefined;
  if (limit && (isNaN(limitN!) || limitN! <= 0)) {
    throw new Error(`--limit must be a positive integer, got: ${limit}`);
  }
  const types = typeFilter ? [typeFilter] : DEFAULT_TYPES;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('backfill-backlinks.scan');

  const stats: BackfillStats = {
    pages_walked: 0,
    pages_with_entity_refs: 0,
    edges_created: 0,
    timeline_created: 0,
    skipped: 0,
    errors: 0,
    per_type: {},
  };
  for (const t of types) stats.per_type[t] = { walked: 0, edges_created: 0, timeline_created: 0 };

  // Pull candidate pages. listPages doesn't accept array filter; we walk
  // per-type and union the results. The per-type walks are sequential
  // (engine round-trip already amortizes the cost) and the dedupe on
  // slug below makes repeat slugs safe.
  const seen = new Set<string>();
  const candidates: Array<{ slug: string; type: string }> = [];
  for (const t of types) {
    const pages = await engine.listPages({ type: t as PageType, limit: limitN ?? 100000, sort: 'updated_desc' });
    for (const p of pages) {
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);
      candidates.push({ slug: p.slug, type: p.type ?? t });
      if (limitN && candidates.length >= limitN) break;
    }
    if (limitN && candidates.length >= limitN) break;
  }

  const stopHb = startHeartbeat(progress, `walking ${candidates.length} pages, extracting entity refs...`);

  // Single resolver shared across the run - its cache is per-name, so we
  // resolve "Alice Chen" once even if she appears in 200 meetings.
  const resolver = makeResolver(engine, { mode: 'batch' });

  try {
    for (const c of candidates) {
      stats.pages_walked++;
      if (stats.per_type[c.type]) stats.per_type[c.type].walked++;

      const page = await engine.getPage(c.slug);
      if (!page) {
        stats.errors++;
        continue;
      }

      const fullContent = (page.compiled_truth ?? '') + '\n' + (page.timeline ?? '');
      const { candidates: linkCandidates } = await extractPageLinks(
        page.slug,
        fullContent,
        page.frontmatter ?? {},
        page.type as PageType,
        resolver,
      );

      if (linkCandidates.length === 0) continue;
      stats.pages_with_entity_refs++;

      if (dryRun) {
        // Count what WOULD be written without invoking writeBackLinks.
        // Filter mirroring filterEligibleCandidates' people/companies rule.
        const wouldWrite = linkCandidates.filter(lc => {
          const dir = lc.targetSlug.split('/')[0];
          return (dir === 'people' || dir === 'companies') && lc.targetSlug !== page.slug;
        });
        stats.edges_created += wouldWrite.length;
        stats.timeline_created += wouldWrite.length;
        const t = stats.per_type[c.type];
        if (t) {
          t.edges_created += wouldWrite.length;
          t.timeline_created += wouldWrite.length;
        }
        continue;
      }

      const title = (page.frontmatter?.title as string | undefined) ?? page.title ?? page.slug;
      const result: BackLinkResult = await writeBackLinks(
        engine,
        page.slug,
        title,
        page.frontmatter ?? {},
        linkCandidates,
      );
      stats.edges_created += result.edges_created;
      stats.timeline_created += result.timeline_created;
      stats.skipped += result.skipped;
      stats.errors += result.errors;
      const t = stats.per_type[c.type];
      if (t) {
        t.edges_created += result.edges_created;
        t.timeline_created += result.timeline_created;
      }
    }
  } finally {
    stopHb();
    progress.finish();
  }

  if (json) {
    console.log(JSON.stringify({ ...stats, dry_run: dryRun }, null, 2));
    return;
  }

  console.log(`\nBack-link backfill ${dryRun ? '(DRY RUN) ' : ''}complete:`);
  console.log(`  Pages walked: ${stats.pages_walked}`);
  console.log(`  Pages with entity refs: ${stats.pages_with_entity_refs}`);
  console.log(`  Edges ${dryRun ? 'would be created' : 'created'}: ${stats.edges_created}`);
  console.log(`  Timeline entries ${dryRun ? 'would be created' : 'created'}: ${stats.timeline_created}`);
  console.log(`  Skipped (non-entity targets, self-refs): ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log(`\n  Per-type breakdown:`);
  for (const [t, d] of Object.entries(stats.per_type).sort((a, b) => b[1].walked - a[1].walked)) {
    if (d.walked === 0) continue;
    console.log(`    ${t}: ${d.walked} pages walked, ${d.edges_created} edges, ${d.timeline_created} timeline entries`);
  }
}
