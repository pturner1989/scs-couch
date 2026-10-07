# scs-couch

[![CI](https://github.com/pturner1989/scs-couch/actions/workflows/ci.yml/badge.svg)](https://github.com/pturner1989/scs-couch/actions/workflows/ci.yml)

A Simple Context Service (SCS) MCP server that keeps SDD artifacts in CouchDB.
The sddv3 skills ([ragnarula/converge](https://github.com/ragnarula/converge))
store their artifacts through an MCP server named `scs`. This server provides
the tools their `artifacts` skill uses, so the skills run unchanged against a
CouchDB you run yourself.

It is single-user and has no authentication: run it on a network you trust,
and do not publish its port to the internet.

## Run with Docker

The image is `ghcr.io/pturner1989/scs-couch`, for `linux/amd64` and
`linux/arm64`. Tags: `latest` follows `main`, and each release `vX.Y.Z` is
also tagged `X.Y.Z` and `X.Y`.

### With a new CouchDB

[`compose.yaml`](compose.yaml) runs the server and a CouchDB of its own:

```bash
git clone https://github.com/pturner1989/scs-couch && cd scs-couch
echo 'COUCHDB_PASSWORD=choose-a-password' > .env
docker compose up -d
curl http://localhost:8080/healthz
```

### With a CouchDB you already run

```bash
docker run -d --name scs --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e COUCHDB_URL=http://couchdb.example:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=... \
  ghcr.io/pturner1989/scs-couch:latest
```

The server creates its database at start when the login may create it.
Otherwise create the database first and give the login access to it.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `COUCHDB_URL` | required | CouchDB root, for example `http://couchdb:5984` |
| `COUCHDB_USER`, `COUCHDB_PASSWORD` | none | The login, when CouchDB needs one |
| `COUCHDB_DB` | `scs` | The database |
| `PORT` | `8080` | The port serving `POST /mcp` and `GET /healthz` |

The MCP endpoint is `http://<host>:8080/mcp`, over Streamable HTTP without
MCP sessions. `GET /healthz` answers 200 when the database is reachable.

## Connect a client

Register the server under the name `scs`, because the sddv3 skills call it
by that name.

- Claude Code: `claude mcp add --transport http scs http://localhost:8080/mcp`
- [Bosun](https://github.com/ragnarula/bosun): add an MCP server named `scs`
  with the URL above and no authentication, then select it when you create a
  session.

## Tools


| Tool | Does |
|---|---|
| `get_signed_in_account` | Confirms the server is connected |
| `list_concepts` | Concept names, optionally only those linked to a repository URL |
| `create_concept` | A concept, with the repository URLs it belongs to |
| `get_artifact` | The latest revision of an artifact, or the one `revision_id` names |
| `save_artifact_revision` | A new revision; `base_revision_id` must name the current one |
| `list_artifact_revisions` | Every revision, newest first, without bodies |

Artifact kinds are `problem`, `research`, `specification`, `design`, `tasks`,
`adr` and `roadmap`. A body may be at most 1 MiB. Refusals are tool errors
whose structured content carries an `error_code`: `conflict` (with
`current_revision`), `concept_not_found_for_signed_in_account`,
`artifact_has_no_saved_revision`, `revision_not_found`,
`concept_already_exists`, `invalid_concept_name`, `body_too_large`, and
`storage_unavailable`.

## Storage

Everything lives in one database. A concept is the document
`concept:<name>`. Each revision is its own document,
`rev:<concept>:<kind>:<number>`, and is never changed or deleted. A save
creates the next number's document, and CouchDB refuses to create one that
exists, so of two saves on the same base only one succeeds.

## Develop

Node 22 or later.

```bash
npm ci
npm run typecheck
npm run build
COUCHDB_URL=http://127.0.0.1:5984 COUCHDB_USER=admin COUCHDB_PASSWORD=... npm start
```

The tests drive the server through the MCP client against a real CouchDB,
in a database of their own that they delete afterwards:

```bash
COUCHDB_URL=http://127.0.0.1:5984 COUCHDB_USER=admin COUCHDB_PASSWORD=... npm test
```

## Licence

MIT. See [LICENSE](LICENSE).
