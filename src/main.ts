import { couchFromEnv, ensureDatabase } from './couch.js';
import { startHttpServer } from './http.js';

const couch = couchFromEnv(process.env);
const port = Number(process.env.PORT ?? 8080);

await ensureDatabase(couch);
await startHttpServer(couch, port);
console.log(JSON.stringify({ level: 'info', msg: 'listening', port, couchdb: couch.url, db: couch.db }));
