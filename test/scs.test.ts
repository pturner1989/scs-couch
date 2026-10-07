// Drives the server through the MCP client over HTTP, against a real CouchDB.
// Needs COUCHDB_URL, and COUCHDB_USER and COUCHDB_PASSWORD when the server
// requires a login. Each run uses a database of its own and deletes it.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { couchFromEnv, couchRequest, ensureDatabase } from '../src/couch.js';
import { startHttpServer } from '../src/http.js';
import { MAX_BODY_BYTES } from '../src/store.js';

const couch = couchFromEnv({ ...process.env, COUCHDB_DB: `scs_test_${Date.now()}` });
let server: Server;
let client: Client;
let endpoint: URL;

beforeAll(async () => {
  await ensureDatabase(couch);
  server = await startHttpServer(couch, 0);
  endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  client = new Client({ name: 'scs-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint));
});

afterAll(async () => {
  await client?.close();
  await new Promise((resolve) => server?.close(resolve));
  await couchRequest(couch, 'DELETE', encodeURIComponent(couch.db));
});

interface Outcome {
  isError: boolean;
  // The structured content, read field by field in each test.
  data: any;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: result.structuredContent };
}

let counter = 0;
/** A concept of its own for each test, so tests do not share state. */
async function newConcept(repositoryUrls?: string[]): Promise<string> {
  counter += 1;
  const name = `feature-${counter}`;
  const created = await call('create_concept', { name, repository_urls: repositoryUrls });
  expect(created.isError).toBe(false);
  return name;
}

describe('the SCS tools', () => {
  it('lists the six tools the artifacts skill uses', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_concept',
      'get_artifact',
      'get_signed_in_account',
      'list_artifact_revisions',
      'list_concepts',
      'save_artifact_revision',
    ]);
  });

  it('confirms the signed-in account', async () => {
    const outcome = await call('get_signed_in_account');
    expect(outcome).toEqual({
      isError: false,
      data: { account_id: 'local', display_name: 'Local SCS on CouchDB' },
    });
  });

  it('saves a first revision and reads it back as current', async () => {
    const concept = await newConcept();
    const saved = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'problem',
      body: '# Problem',
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.revision.revision_number).toBe(1);

    const read = await call('get_artifact', { concept_name: concept, artifact_kind: 'problem' });
    expect(read.isError).toBe(false);
    expect(read.data.body).toBe('# Problem');
    expect(read.data.revision.revision_id).toBe(saved.data.revision.revision_id);
    expect(read.data.is_current).toBe(true);
  });

  it('saves an update on the current base, and keeps the old revision readable', async () => {
    const concept = await newConcept();
    const first = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'design',
      body: 'v1',
    });
    const second = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'design',
      body: 'v2',
      base_revision_id: first.data.revision.revision_id,
    });
    expect(second.isError).toBe(false);
    expect(second.data.revision.revision_number).toBe(2);

    const old = await call('get_artifact', {
      concept_name: concept,
      artifact_kind: 'design',
      revision_id: first.data.revision.revision_id,
    });
    expect(old.data.body).toBe('v1');
    expect(old.data.is_current).toBe(false);

    const listed = await call('list_artifact_revisions', {
      concept_name: concept,
      artifact_kind: 'design',
    });
    expect(listed.data.revisions.map((revision: { revision_number: number }) => revision.revision_number)).toEqual([2, 1]);
  });

  it('refuses a save on a stale base, naming the current revision', async () => {
    const concept = await newConcept();
    const first = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'tasks',
      body: 'v1',
    });
    const second = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'tasks',
      body: 'v2',
      base_revision_id: first.data.revision.revision_id,
    });
    const stale = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'tasks',
      body: 'v2 from elsewhere',
      base_revision_id: first.data.revision.revision_id,
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error_code).toBe('conflict');
    expect(stale.data.current_revision.revision_id).toBe(second.data.revision.revision_id);
  });

  it('refuses a save without a base once a revision exists', async () => {
    const concept = await newConcept();
    await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'specification',
      body: 'v1',
    });
    const again = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'specification',
      body: 'v1 again',
    });
    expect(again.isError).toBe(true);
    expect(again.data.error_code).toBe('conflict');
    expect(again.data.current_revision.revision_number).toBe(1);
  });

  it('lets exactly one of two saves on the same base through', async () => {
    const concept = await newConcept();
    const first = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'research',
      body: 'v1',
    });
    const base = first.data.revision.revision_id;
    const outcomes = await Promise.all(
      ['a', 'b', 'c'].map((body) =>
        call('save_artifact_revision', {
          concept_name: concept,
          artifact_kind: 'research',
          body,
          base_revision_id: base,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => !outcome.isError)).toHaveLength(1);
    for (const refused of outcomes.filter((outcome) => outcome.isError)) {
      expect(refused.data.error_code).toBe('conflict');
    }
  });

  it('says when a concept or an artifact does not exist', async () => {
    const missing = await call('get_artifact', { concept_name: 'nowhere', artifact_kind: 'problem' });
    expect(missing.data.error_code).toBe('concept_not_found_for_signed_in_account');

    const concept = await newConcept();
    const unwritten = await call('get_artifact', { concept_name: concept, artifact_kind: 'design' });
    expect(unwritten.isError).toBe(true);
    expect(unwritten.data.error_code).toBe('artifact_has_no_saved_revision');
  });

  it('refuses a concept that already exists, and a name that is not kebab-case', async () => {
    const concept = await newConcept();
    const again = await call('create_concept', { name: concept });
    expect(again.data.error_code).toBe('concept_already_exists');

    const bad = await call('create_concept', { name: 'Not Kebab' });
    expect(bad.data.error_code).toBe('invalid_concept_name');
  });

  it('accepts a deliverable under an initiative', async () => {
    const created = await call('create_concept', { name: 'big-initiative/d-01-first-step' });
    expect(created.isError).toBe(false);
    const saved = await call('save_artifact_revision', {
      concept_name: 'big-initiative/d-01-first-step',
      artifact_kind: 'problem',
      body: 'p',
    });
    expect(saved.isError).toBe(false);
  });

  it('finds concepts by repository, whatever the trailing slash or .git', async () => {
    const linked = await newConcept(['https://github.com/acme/widget.git']);
    await newConcept(['https://github.com/acme/other']);

    const found = await call('list_concepts', { repository_url: 'https://github.com/acme/widget/' });
    expect(found.data.concepts).toEqual([linked]);
  });

  it('refuses a body over 1 MiB', async () => {
    const concept = await newConcept();
    const outcome = await call('save_artifact_revision', {
      concept_name: concept,
      artifact_kind: 'design',
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(outcome.data.error_code).toBe('body_too_large');
  });

  it('answers a method it does not know with a JSON-RPC error, as Bosun probes first', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });
    const body = (await response.json()) as { error?: { code: number } };
    expect(body.error).toBeDefined();
  });
});
