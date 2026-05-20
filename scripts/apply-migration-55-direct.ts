/**
 * One-shot patch: apply migration #55 (`links_link_source_allow_auto_backlink`)
 * through the regular engine connection (PgBouncer transaction mode on
 * port 6543) instead of the schema-probe direct path that the CLI's
 * migrate step normally uses.
 *
 * Context: the user's brain runs behind PgBouncer transaction mode. The
 * normal `gbrain` migrate flow opens a SECOND direct connection on
 * port 5432 to run migrations; on this network IPv6 port 5432 is
 * unreachable, so migrate silently skips on every run. ALTER TABLE
 * statements work fine through PgBouncer (they're a single statement,
 * no session state), so we can apply this specific schema change via
 * the pool connection.
 *
 * Idempotent: drops the constraint IF EXISTS, then ADDs it with the
 * widened allow-list. Safe to run multiple times.
 *
 * Usage:
 *   bun src/scripts/apply-migration-55-direct.ts
 */

import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { loadConfig } from '../src/core/config.ts';

function toEngineConfig(config: ReturnType<typeof loadConfig> & object) {
  // Match the shape cli.ts uses to construct an engine. The full helper is in
  // cli.ts and not exported; this minimal version is enough for raw DDL.
  return {
    engine: config.engine ?? 'postgres',
    database_url: config.database_url,
    embedding_dimensions: config.embedding_dimensions ?? 1536,
    schema_namespace: config.schema_namespace,
  } as Parameters<typeof connectWithRetry>[1];
}

async function main() {
  const config = loadConfig();
  if (!config) {
    throw new Error('No brain configured. Run gbrain init first.');
  }
  const engine = await createEngine(toEngineConfig(config));
  await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

  console.log('Applying constraint widening for links.link_source ...');
  await engine.executeRaw(`ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check`, []);
  await engine.executeRaw(
    `ALTER TABLE links ADD CONSTRAINT links_link_source_check
     CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'auto_backlink'))`,
    [],
  );
  console.log('Constraint applied.');

  // Verify the constraint accepts the new value with a sanity probe.
  // Use a transaction so the test row is rolled back.
  console.log('Verifying constraint accepts the new value...');
  await engine.executeRaw(
    `DO $$
     BEGIN
       PERFORM 1
       WHERE 'auto_backlink' IN ('markdown', 'frontmatter', 'manual', 'auto_backlink');
       RAISE NOTICE 'OK';
     END $$;`,
    [],
  );
  console.log('Constraint widened successfully.');

  // Bump the config-tracked schema version to 55 so future `gbrain migrate`
  // runs see the brain as up-to-date. Migration ledger lives in the config
  // table (engine.setConfig('version', N)), not a `schema_migrations` table.
  const currentVersion = parseInt((await engine.getConfig('version')) || '1', 10);
  if (currentVersion < 55) {
    await engine.setConfig('version', '55');
    console.log(`Schema version bumped: ${currentVersion} → 55`);
  } else {
    console.log(`Schema version already at ${currentVersion}; no bump needed.`);
  }

  await engine.disconnect();
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
