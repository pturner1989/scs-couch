// The SCS tool surface, as the sddv3 `artifacts` skill uses it.
//
// Each result carries a one-line summary as text and the data as structured
// content. Bosun shows a model both, so the body travels once, in the
// structured part. A refusal is an error result whose structured content has
// the `error_code` the skill acts on.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Couch } from './couch.js';
import {
  ARTIFACT_KINDS,
  type Result,
  type StoreError,
  createConcept,
  getArtifact,
  listArtifactRevisions,
  listConcepts,
  saveArtifactRevision,
} from './store.js';

/** The one account this single-user service signs everyone in as. */
const ACCOUNT = { account_id: 'local', display_name: 'Local SCS on CouchDB' };

const kind = z.enum(ARTIFACT_KINDS).describe('The artifact kind');
const conceptName = z
  .string()
  .describe('The concept name: kebab-case, with / between an initiative and a deliverable');

function success(summary: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: data };
}

function refusal(error: StoreError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.error_code}: ${error.message}` }],
    structuredContent: error,
  };
}

function storageUnavailable(error: unknown): CallToolResult {
  console.error(JSON.stringify({ level: 'error', msg: 'storage call failed', error: String(error) }));
  return refusal({ error_code: 'storage_unavailable', message: String(error) });
}

/** Runs a store call, turning a refusal or a storage failure into a result. */
async function respond<T>(
  call: () => Promise<Result<T>>,
  render: (value: T) => CallToolResult,
): Promise<CallToolResult> {
  try {
    const result = await call();
    return result.ok ? render(result.value) : refusal(result.error);
  } catch (error) {
    return storageUnavailable(error);
  }
}

export function buildServer(couch: Couch): McpServer {
  const server = new McpServer({ name: 'scs', version: '0.1.0' });

  server.registerTool(
    'get_signed_in_account',
    {
      description: 'The account this server stores artifacts for. Confirms the server is connected.',
      inputSchema: {},
    },
    async () => success(`signed in as ${ACCOUNT.account_id}`, ACCOUNT),
  );

  server.registerTool(
    'list_concepts',
    {
      description:
        'List concept names, all of them or only those linked to a repository. Returns names only.',
      inputSchema: {
        repository_url: z
          .string()
          .optional()
          .describe('Only concepts linked to this repository URL'),
      },
    },
    async ({ repository_url }) => {
      try {
        const concepts = await listConcepts(couch, repository_url);
        return success(`${concepts.length} concepts`, { concepts });
      } catch (error) {
        return storageUnavailable(error);
      }
    },
  );

  server.registerTool(
    'create_concept',
    {
      description: 'Create a concept to hold the artifacts of one piece of work.',
      inputSchema: {
        name: conceptName,
        repository_urls: z
          .array(z.string())
          .optional()
          .describe('Repositories the work belongs to, so later lookups by repository find it'),
      },
    },
    async ({ name, repository_urls }) =>
      respond(
        () => createConcept(couch, name, repository_urls ?? []),
        (concept) => success(`created concept ${concept.name}`, { concept }),
      ),
  );

  server.registerTool(
    'get_artifact',
    {
      description:
        'Read an artifact: the latest revision, or the one revision_id names. Keep revision.revision_id for the next save.',
      inputSchema: {
        concept_name: conceptName,
        artifact_kind: kind,
        revision_id: z.string().optional().describe('A revision to read; the latest when absent'),
      },
    },
    async ({ concept_name, artifact_kind, revision_id }) =>
      respond(
        () => getArtifact(couch, concept_name, artifact_kind, revision_id),
        (artifact) =>
          success(
            `${artifact.concept_name} ${artifact.artifact_kind}, revision ${artifact.revision.revision_number}${artifact.is_current ? ' (current)' : ''}`,
            { ...artifact },
          ),
      ),
  );

  server.registerTool(
    'save_artifact_revision',
    {
      description:
        'Save a new revision of an artifact. Omit base_revision_id for the first revision; otherwise pass the current revision_id from get_artifact. A save over a newer revision is refused with error_code conflict.',
      inputSchema: {
        concept_name: conceptName,
        artifact_kind: kind,
        body: z.string().describe('The whole artifact, at most 1 MiB'),
        base_revision_id: z
          .string()
          .optional()
          .describe('The revision this save replaces; absent for the first revision'),
      },
    },
    async ({ concept_name, artifact_kind, body, base_revision_id }) =>
      respond(
        () => saveArtifactRevision(couch, concept_name, artifact_kind, body, base_revision_id),
        (revision) =>
          success(`saved ${concept_name} ${artifact_kind} revision ${revision.revision_number}`, {
            concept_name,
            artifact_kind,
            revision,
          }),
      ),
  );

  server.registerTool(
    'list_artifact_revisions',
    {
      description: 'List the revisions of an artifact, newest first, without their bodies.',
      inputSchema: { concept_name: conceptName, artifact_kind: kind },
    },
    async ({ concept_name, artifact_kind }) =>
      respond(
        () => listArtifactRevisions(couch, concept_name, artifact_kind),
        (revisions) =>
          success(`${revisions.length} revisions`, { concept_name, artifact_kind, revisions }),
      ),
  );

  return server;
}
