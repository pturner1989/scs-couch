// Concepts and artifact revisions, kept as CouchDB documents.
//
// A concept is the document `concept:<name>`. Each revision of an artifact is
// its own document, `rev:<concept>:<kind>:<number>`, with the number padded so
// that key order is revision order. A save creates the next number's document;
// CouchDB refuses to create a document that already exists, so of two saves on
// the same base exactly one succeeds and the other is a conflict. Revisions
// are never changed or deleted.

import {
  type Couch,
  CouchError,
  couchRequest,
  docPath,
  rangePath,
} from './couch.js';

export const ARTIFACT_KINDS = [
  'problem',
  'research',
  'specification',
  'design',
  'tasks',
  'adr',
  'roadmap',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The largest body a revision may hold, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Kebab-case names, with `/` between an initiative and its deliverable. */
const CONCEPT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;

export function isConceptName(name: string): boolean {
  return CONCEPT_NAME.test(name);
}

const NUMBER_DIGITS = 6;

export interface Concept {
  name: string;
  repository_urls: string[];
  created_at: string;
}

export interface Revision {
  revision_id: string;
  revision_number: number;
  created_at: string;
}

export interface Artifact {
  concept_name: string;
  artifact_kind: ArtifactKind;
  body: string;
  revision: Revision;
  is_current: boolean;
}

/** A refusal the caller can act on, in the shape the SCS tools report. */
export interface StoreError {
  error_code: string;
  message: string;
  [detail: string]: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

interface ConceptDoc extends Concept {
  _id: string;
  type: 'concept';
}

interface RevisionDoc {
  _id: string;
  type: 'revision';
  concept_name: string;
  artifact_kind: ArtifactKind;
  revision_number: number;
  body: string;
  created_at: string;
}

interface RangeRow<T> {
  id: string;
  doc?: T;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: StoreError): Result<T> => ({ ok: false, error });

function conceptId(name: string): string {
  return `concept:${name}`;
}

function revisionPrefix(concept: string, kind: ArtifactKind): string {
  return `rev:${concept}:${kind}:`;
}

function revisionId(concept: string, kind: ArtifactKind, number: number): string {
  return revisionPrefix(concept, kind) + String(number).padStart(NUMBER_DIGITS, '0');
}

function revisionOf(doc: RevisionDoc): Revision {
  return {
    revision_id: doc._id,
    revision_number: doc.revision_number,
    created_at: doc.created_at,
  };
}

/**
 * A repository URL in the form used for matching: no trailing slash and no
 * `.git`, so `https://host/repo.git` and `https://host/repo/` are the same.
 */
export function normalizeRepositoryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}

function conceptNotFound(name: string): StoreError {
  return {
    error_code: 'concept_not_found_for_signed_in_account',
    message: `concept ${name} does not exist; create it with create_concept`,
  };
}

async function readConcept(couch: Couch, name: string): Promise<ConceptDoc | undefined> {
  const response = await couchRequest(couch, 'GET', docPath(couch, conceptId(name)));
  if (response.status === 404) {
    return undefined;
  }
  if (response.status !== 200) {
    throw new CouchError(`cannot read concept ${name}`, response);
  }
  return response.body as ConceptDoc;
}

async function latestRevision(
  couch: Couch,
  concept: string,
  kind: ArtifactKind,
): Promise<RevisionDoc | undefined> {
  const prefix = revisionPrefix(concept, kind);
  const response = await couchRequest(
    couch,
    'GET',
    rangePath(couch, { start: `${prefix}￰`, end: prefix, descending: true, limit: 1 }),
  );
  if (response.status !== 200) {
    throw new CouchError(`cannot list revisions of ${concept} ${kind}`, response);
  }
  const rows = (response.body as { rows: RangeRow<RevisionDoc>[] }).rows;
  return rows[0]?.doc;
}

export async function createConcept(
  couch: Couch,
  name: string,
  repositoryUrls: string[],
): Promise<Result<Concept>> {
  if (!isConceptName(name)) {
    return fail({
      error_code: 'invalid_concept_name',
      message: `concept names are kebab-case, with / between an initiative and a deliverable; got ${name}`,
    });
  }
  const concept: Concept = {
    name,
    repository_urls: repositoryUrls,
    created_at: new Date().toISOString(),
  };
  const doc: ConceptDoc = { _id: conceptId(name), type: 'concept', ...concept };
  const response = await couchRequest(couch, 'PUT', docPath(couch, doc._id), doc);
  if (response.status === 409) {
    return fail({ error_code: 'concept_already_exists', message: `concept ${name} already exists` });
  }
  if (response.status !== 201 && response.status !== 202) {
    throw new CouchError(`cannot create concept ${name}`, response);
  }
  return ok(concept);
}

/** Concept names, all of them or those linked to `repositoryUrl`. */
export async function listConcepts(couch: Couch, repositoryUrl?: string): Promise<string[]> {
  const response = await couchRequest(
    couch,
    'GET',
    rangePath(couch, { start: 'concept:', end: 'concept:￰' }),
  );
  if (response.status !== 200) {
    throw new CouchError('cannot list concepts', response);
  }
  const rows = (response.body as { rows: RangeRow<ConceptDoc>[] }).rows;
  const wanted = repositoryUrl === undefined ? undefined : normalizeRepositoryUrl(repositoryUrl);
  return rows
    .flatMap((row) => (row.doc ? [row.doc] : []))
    .filter(
      (doc) =>
        wanted === undefined ||
        doc.repository_urls.some((url) => normalizeRepositoryUrl(url) === wanted),
    )
    .map((doc) => doc.name);
}

export async function getArtifact(
  couch: Couch,
  concept: string,
  kind: ArtifactKind,
  revisionIdWanted?: string,
): Promise<Result<Artifact>> {
  if (!(await readConcept(couch, concept))) {
    return fail(conceptNotFound(concept));
  }
  const latest = await latestRevision(couch, concept, kind);
  let doc = latest;
  if (revisionIdWanted !== undefined) {
    doc = undefined;
    if (revisionIdWanted.startsWith(revisionPrefix(concept, kind))) {
      const response = await couchRequest(couch, 'GET', docPath(couch, revisionIdWanted));
      if (response.status === 200) {
        doc = response.body as RevisionDoc;
      } else if (response.status !== 404) {
        throw new CouchError(`cannot read revision ${revisionIdWanted}`, response);
      }
    }
    if (!doc) {
      return fail({
        error_code: 'revision_not_found',
        message: `${concept} ${kind} has no revision ${revisionIdWanted}`,
      });
    }
  }
  if (!doc) {
    return fail({
      error_code: 'artifact_has_no_saved_revision',
      message: `${concept} has no saved ${kind}`,
    });
  }
  return ok({
    concept_name: concept,
    artifact_kind: kind,
    body: doc.body,
    revision: revisionOf(doc),
    is_current: doc._id === latest?._id,
  });
}

/**
 * Saves `body` as the next revision. `baseRevisionId` must name the current
 * revision, and must be absent only for the first one; anything else is a
 * conflict that names the current revision, so the caller can re-read, merge
 * and save again.
 */
export async function saveArtifactRevision(
  couch: Couch,
  concept: string,
  kind: ArtifactKind,
  body: string,
  baseRevisionId?: string,
): Promise<Result<Revision>> {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    return fail({
      error_code: 'body_too_large',
      message: `the body is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}`,
    });
  }
  if (!(await readConcept(couch, concept))) {
    return fail(conceptNotFound(concept));
  }
  const latest = await latestRevision(couch, concept, kind);
  if ((latest?._id ?? undefined) !== baseRevisionId) {
    return fail(conflict(concept, kind, latest));
  }
  const number = (latest?.revision_number ?? 0) + 1;
  const doc: RevisionDoc = {
    _id: revisionId(concept, kind, number),
    type: 'revision',
    concept_name: concept,
    artifact_kind: kind,
    revision_number: number,
    body,
    created_at: new Date().toISOString(),
  };
  const response = await couchRequest(couch, 'PUT', docPath(couch, doc._id), doc);
  if (response.status === 409) {
    // Another save took this number between the read and the write.
    return fail(conflict(concept, kind, await latestRevision(couch, concept, kind)));
  }
  if (response.status !== 201 && response.status !== 202) {
    throw new CouchError(`cannot save ${concept} ${kind}`, response);
  }
  return ok(revisionOf(doc));
}

function conflict(concept: string, kind: ArtifactKind, current: RevisionDoc | undefined): StoreError {
  return {
    error_code: 'conflict',
    message: current
      ? `${concept} ${kind} is at revision ${current.revision_number}; re-read it, merge, and save with base_revision_id ${current._id}`
      : `${concept} has no saved ${kind}; save the first revision without base_revision_id`,
    current_revision: current ? revisionOf(current) : null,
  };
}

/** Every revision of an artifact, newest first, without bodies. */
export async function listArtifactRevisions(
  couch: Couch,
  concept: string,
  kind: ArtifactKind,
): Promise<Result<Revision[]>> {
  if (!(await readConcept(couch, concept))) {
    return fail(conceptNotFound(concept));
  }
  const prefix = revisionPrefix(concept, kind);
  const response = await couchRequest(
    couch,
    'GET',
    rangePath(couch, { start: `${prefix}￰`, end: prefix, descending: true }),
  );
  if (response.status !== 200) {
    throw new CouchError(`cannot list revisions of ${concept} ${kind}`, response);
  }
  const rows = (response.body as { rows: RangeRow<RevisionDoc>[] }).rows;
  return ok(rows.flatMap((row) => (row.doc ? [revisionOf(row.doc)] : [])));
}
