// The few CouchDB calls the store needs, over CouchDB's HTTP API.

export interface Couch {
  /** Server root, for example `http://couchdb:5984`. */
  url: string;
  /** The database that holds every concept and revision. */
  db: string;
  /** A `Basic` authorization header value, when the server needs a login. */
  authorization?: string;
}

export interface CouchResponse {
  status: number;
  body: unknown;
}

export function couchFromEnv(env: NodeJS.ProcessEnv): Couch {
  const url = env.COUCHDB_URL;
  if (!url) {
    throw new Error('COUCHDB_URL is not set');
  }
  const couch: Couch = { url: url.replace(/\/+$/, ''), db: env.COUCHDB_DB ?? 'scs' };
  if (env.COUCHDB_USER) {
    const login = `${env.COUCHDB_USER}:${env.COUCHDB_PASSWORD ?? ''}`;
    couch.authorization = `Basic ${Buffer.from(login).toString('base64')}`;
  }
  return couch;
}

/**
 * Sends one request. `path` is relative to the server root. A status the
 * caller does not expect is the caller's to turn into an error.
 */
export async function couchRequest(
  couch: Couch,
  method: string,
  path: string,
  body?: unknown,
): Promise<CouchResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (couch.authorization) {
    headers.authorization = couch.authorization;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${couch.url}/${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The path of one document in the database. */
export function docPath(couch: Couch, id: string): string {
  return `${encodeURIComponent(couch.db)}/${encodeURIComponent(id)}`;
}

/** The path of `_all_docs` over a key range, with the documents included. */
export function rangePath(
  couch: Couch,
  range: { start: string; end: string; descending?: boolean; limit?: number },
): string {
  const query = new URLSearchParams({
    startkey: JSON.stringify(range.start),
    endkey: JSON.stringify(range.end),
    include_docs: 'true',
  });
  if (range.descending) {
    query.set('descending', 'true');
  }
  if (range.limit !== undefined) {
    query.set('limit', String(range.limit));
  }
  return `${encodeURIComponent(couch.db)}/_all_docs?${query}`;
}

/** Thrown when CouchDB answers in a way the store does not handle. */
export class CouchError extends Error {
  constructor(what: string, response: CouchResponse) {
    super(`${what}: CouchDB answered ${response.status} ${JSON.stringify(response.body)}`);
  }
}

/**
 * Creates the database when it is missing. A login that may not create
 * databases is enough when the database already exists.
 */
export async function ensureDatabase(couch: Couch): Promise<void> {
  const created = await couchRequest(couch, 'PUT', encodeURIComponent(couch.db));
  if (created.status === 201 || created.status === 202 || created.status === 412) {
    return;
  }
  const existing = await couchRequest(couch, 'GET', encodeURIComponent(couch.db));
  if (existing.status !== 200) {
    throw new CouchError(`cannot create or open database ${couch.db}`, created);
  }
}
