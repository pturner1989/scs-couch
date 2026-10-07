// The sddv2 import, against a real CouchDB. Needs the same COUCHDB_* variables
// as the server tests, and uses a database of its own that it deletes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { couchFromEnv, couchRequest, ensureDatabase } from '../src/couch.js';
import { importedBody, planImport, runImport } from '../src/sddv2.js';
import { getArtifact, listArtifactRevisions, listConcepts } from '../src/store.js';

const couch = couchFromEnv({ ...process.env, COUCHDB_DB: `scs_import_test_${Date.now()}` });
const REPOSITORY_URLS = ['git@github.com:acme/widget.git', '/repos/widget.git'];
let root: string;

function write(path: string, body: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

beforeAll(async () => {
  await ensureDatabase(couch);
  root = mkdtempSync(join(tmpdir(), 'sdd-'));
  write('handbook.md', '# Handbook');
  write('index.md', '# Index');
  write('probes/check.mjs', '// probe');
  write('payments/roadmap.md', '# Roadmap');
  write('payments/research.md', '# Research');
  write('payments/refunds/specification.md', '# Spec');
  write('payments/refunds/design.md', '# Design');
  write('payments/refunds/tasks.md', '# Tasks');
  write('payments/refunds/deployment-evidence.md', '# Evidence');
  write('search/design.md', '# Search design');
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await couchRequest(couch, 'DELETE', encodeURIComponent(couch.db));
});

describe('the sddv2 import', () => {
  it('maps each artifact file to a concept and kind, and keeps the rest in the repository', () => {
    const plan = planImport(root);
    expect(plan.artifacts.map((a) => [a.path, a.concept, a.kind])).toEqual([
      ['payments/refunds/design.md', 'payments/refunds', 'design'],
      ['payments/refunds/specification.md', 'payments/refunds', 'specification'],
      ['payments/refunds/tasks.md', 'payments/refunds', 'tasks'],
      ['payments/research.md', 'payments', 'research'],
      ['payments/roadmap.md', 'payments', 'roadmap'],
      ['search/design.md', 'search', 'design'],
    ]);
    expect(plan.concepts).toEqual(['payments', 'payments/refunds', 'search']);
    expect(plan.kept).toEqual(['handbook.md', 'index.md', 'probes/check.mjs']);
    expect(plan.unmapped).toEqual(['payments/refunds/deployment-evidence.md']);
  });

  it('saves every artifact with a line naming its source, linked to every repository address', async () => {
    const report = await runImport(couch, planImport(root), REPOSITORY_URLS);
    expect(report.failed).toEqual([]);
    expect(report.saved).toHaveLength(6);

    const design = await getArtifact(couch, 'payments/refunds', 'design');
    expect(design.ok && design.value.body).toBe(
      importedBody('payments/refunds/design.md', '# Design'),
    );
    for (const url of REPOSITORY_URLS) {
      expect(await listConcepts(couch, url)).toEqual(['payments', 'payments/refunds', 'search']);
    }
  });

  it('changes nothing on a second run', async () => {
    const report = await runImport(couch, planImport(root), REPOSITORY_URLS);
    expect(report.saved).toEqual([]);
    expect(report.unchanged).toHaveLength(6);
    expect(report.conceptsExisting).toHaveLength(3);
  });

  it('saves a changed file as the next revision', async () => {
    write('search/design.md', '# Search design, revised');
    const report = await runImport(couch, planImport(root), REPOSITORY_URLS);
    expect(report.saved).toEqual(['search/design.md']);

    const revisions = await listArtifactRevisions(couch, 'search', 'design');
    expect(revisions.ok && revisions.value.map((r) => r.revision_number)).toEqual([2, 1]);
  });
});
