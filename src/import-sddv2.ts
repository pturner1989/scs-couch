// Imports an sddv2 `.sdd/` directory into the database the server uses.
//
//   node dist/import-sddv2.js [--dry-run] --repository-url <url>... <.sdd directory>
//
// It reads the same COUCHDB_* variables as the server. Give --repository-url
// once for each address the repository is cloned from (SSH, HTTPS, a local
// path), because the artifacts skill looks concepts up by `origin`.

import { parseArgs } from 'node:util';

import { couchFromEnv, ensureDatabase } from './couch.js';
import { planImport, runImport } from './sddv2.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    'repository-url': { type: 'string', multiple: true, default: [] },
  },
});

const root = positionals[0];
if (!root || positionals.length > 1) {
  console.error('usage: import-sddv2 [--dry-run] --repository-url <url>... <.sdd directory>');
  process.exit(2);
}

const plan = planImport(root);
const byKind: Record<string, number> = {};
for (const artifact of plan.artifacts) {
  byKind[artifact.kind] = (byKind[artifact.kind] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      artifacts: plan.artifacts.length,
      by_kind: byKind,
      concepts: plan.concepts.length,
      kept_in_repository: plan.kept.length,
      unmapped: plan.unmapped,
    },
    null,
    2,
  ),
);
if (values['dry-run']) {
  process.exit(0);
}

const couch = couchFromEnv(process.env);
await ensureDatabase(couch);
const report = await runImport(couch, plan, values['repository-url']);
console.log(
  JSON.stringify(
    {
      concepts_created: report.conceptsCreated.length,
      concepts_existing: report.conceptsExisting,
      saved: report.saved.length,
      unchanged: report.unchanged.length,
      failed: report.failed,
    },
    null,
    2,
  ),
);
process.exit(report.failed.length > 0 ? 1 : 0);
