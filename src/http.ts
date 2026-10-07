// The MCP endpoint over streamable HTTP, without MCP sessions: each POST gets
// its own server instance, so the process holds no state between requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { type Couch, couchRequest } from './couch.js';
import { MAX_BODY_BYTES } from './store.js';
import { buildServer } from './server.js';

/** A request may carry a full artifact body plus its JSON-RPC envelope. */
const MAX_REQUEST_BYTES = MAX_BODY_BYTES * 2;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error(`the request is larger than ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleMcp(couch: Couch, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    send(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: `cannot read the request: ${String(error)}` },
      id: null,
    });
    return;
  }
  const server = buildServer(couch);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleHealth(couch: Couch, res: ServerResponse): Promise<void> {
  try {
    const response = await couchRequest(couch, 'GET', encodeURIComponent(couch.db));
    send(res, response.status === 200 ? 200 : 503, { couchdb: response.status });
  } catch (error) {
    send(res, 503, { couchdb: String(error) });
  }
}

export function startHttpServer(couch: Couch, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    let handled: Promise<void>;
    if (path === '/mcp' && req.method === 'POST') {
      handled = handleMcp(couch, req, res);
    } else if (path === '/mcp') {
      // There are no MCP sessions, so there is no stream to open or end.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    } else if (path === '/healthz' && req.method === 'GET') {
      handled = handleHealth(couch, res);
    } else {
      res.writeHead(404).end();
      return;
    }
    handled.catch((error: unknown) => {
      console.error(JSON.stringify({ level: 'error', msg: 'request failed', error: String(error) }));
      if (!res.headersSent) {
        send(res, 500, { error: 'internal error' });
      }
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
