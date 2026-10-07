// Imports the artifacts of an sddv2 `.sdd/` directory as SCS concepts and
// revisions, so the sddv3 skills can carry on from them.
//
// sddv2 keeps each artifact as a file: `<initiative>/roadmap.md`,
// `<initiative>/research.md`, and `<initiative>/<deliverable>/{specification,
// design,tasks}.md`. The directory path is the concept name and the file name
// is the artifact kind. Files that are not artifacts (the handbook, the index,
// probes) stay in the repository, and so does anything with no matching kind.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Couch } from './couch.js';
import {
  type ArtifactKind,
  MAX_BODY_BYTES,
  createConcept,
  getArtifact,
  isConceptName,
  saveArtifactRevision,
} from './store.js';

const KIND_OF_FILE: Record<string, ArtifactKind> = {
  'roadmap.md': 'roadmap',
  'research.md': 'research',
  'specification.md': 'specification',
  'design.md': 'design',
  'tasks.md': 'tasks',
};

/** Files sddv2 keeps beside its artifacts, which are not artifacts. */
const NOT_ARTIFACTS = [/^handbook\.md$/, /^index\.md$/, /^probes\//];

export interface PlannedArtifact {
  /** The file's path relative to the `.sdd/` directory. */
  path: string;
  concept: string;
  kind: ArtifactKind;
  body: string;
}

export interface ImportPlan {
  artifacts: PlannedArtifact[];
  /** Every concept the artifacts need, initiatives included, in order. */
  concepts: string[];
  /** Files that are not artifacts. */
  kept: string[];
  /** Files that look like artifacts but have no SCS kind or concept name. */
  unmapped: string[];
}

export interface ImportReport {
  conceptsCreated: string[];
  /** Concepts that existed; their repository links are left as they were. */
  conceptsExisting: string[];
  saved: string[];
  unchanged: string[];
  failed: { path: string; error_code: string; message: string }[];
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * The body an artifact is saved with: the file, after a line that says where
 * it came from, so a reader knows that `.sdd/` paths in it point at the
 * archive left in the repository.
 */
export function importedBody(path: string, file: string): string {
  return (
    `> Imported from \`.sdd/${path}\` (sddv2). Paths under \`.sdd/\` refer to the ` +
    `archive kept in the repository.\n\n${file}`
  );
}

export function planImport(root: string): ImportPlan {
  const plan: ImportPlan = { artifacts: [], concepts: [], kept: [], unmapped: [] };
  const concepts = new Set<string>();
  for (const file of filesUnder(root).sort()) {
    const path = relative(root, file).split(sep).join('/');
    if (NOT_ARTIFACTS.some((pattern) => pattern.test(path))) {
      plan.kept.push(path);
      continue;
    }
    const parts = path.split('/');
    const kind = KIND_OF_FILE[parts.at(-1) ?? ''];
    const concept = parts.slice(0, -1).join('/');
    if (!kind || !isConceptName(concept)) {
      plan.unmapped.push(path);
      continue;
    }
    plan.artifacts.push({
      path,
      concept,
      kind,
      body: importedBody(path, readFileSync(file, 'utf8')),
    });
    concepts.add(concept);
    // A deliverable's initiative is a concept even when it holds no artifact.
    concepts.add(parts[0] as string);
  }
  plan.concepts = [...concepts].sort();
  return plan;
}

/**
 * Creates the concepts and saves each artifact as a new revision. An artifact
 * whose current revision already holds the same body is left alone, so a
 * second run changes nothing, and a run after a file changed saves only that
 * file.
 */
export async function runImport(
  couch: Couch,
  plan: ImportPlan,
  repositoryUrls: string[],
): Promise<ImportReport> {
  const report: ImportReport = {
    conceptsCreated: [],
    conceptsExisting: [],
    saved: [],
    unchanged: [],
    failed: [],
  };
  for (const name of plan.concepts) {
    const created = await createConcept(couch, name, repositoryUrls);
    if (created.ok) {
      report.conceptsCreated.push(name);
    } else if (created.error.error_code === 'concept_already_exists') {
      report.conceptsExisting.push(name);
    } else {
      report.failed.push({ path: name, ...created.error });
    }
  }
  for (const artifact of plan.artifacts) {
    if (Buffer.byteLength(artifact.body, 'utf8') > MAX_BODY_BYTES) {
      report.failed.push({
        path: artifact.path,
        error_code: 'body_too_large',
        message: `the body is larger than ${MAX_BODY_BYTES} bytes`,
      });
      continue;
    }
    const current = await getArtifact(couch, artifact.concept, artifact.kind);
    if (current.ok && current.value.body === artifact.body) {
      report.unchanged.push(artifact.path);
      continue;
    }
    const base = current.ok ? current.value.revision.revision_id : undefined;
    const saved = await saveArtifactRevision(
      couch,
      artifact.concept,
      artifact.kind,
      artifact.body,
      base,
    );
    if (saved.ok) {
      report.saved.push(artifact.path);
    } else {
      report.failed.push({ path: artifact.path, ...saved.error });
    }
  }
  return report;
}
