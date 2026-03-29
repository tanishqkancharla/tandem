---
name: server
description: |
  Call RPC procedures on the local dev server. Use when inspecting server state,
  testing endpoints, or interacting with the app's API.
---

# Server RPC CLI

Use the `.agents/skills/server/cli.ts` CLI to call RPC procedures on the local dev server.

## Authentication

On first use, the CLI authenticates using your local `gcloud` credentials:
1. Runs `gcloud auth print-identity-token` to get a Google ID token
2. Calls `POST /api/auth/cli-login` on the server to verify and get an API key
3. Caches the API key locally for subsequent calls

## Commands

```bash
# Authenticate (happens automatically on first call)
.agents/skills/server/cli.ts login

# Clear cached authentication
.agents/skills/server/cli.ts logout

# Call an RPC procedure
.agents/skills/server/cli.ts call threads.list
.agents/skills/server/cli.ts call threads.get '{"id": "abc-123"}'
.agents/skills/server/cli.ts call threads.create '{"title": "My Thread"}'
.agents/skills/server/cli.ts call dev.usersList
```

## Available Procedures

The RPC procedures are defined in `apps/server/src/router/`. Read the router files to see available procedures and their input schemas.

### threads (apps/server/src/router/threads.ts)
- `threads.list` — List all threads for the authenticated user
- `threads.get` `{id}` — Get a thread by ID
- `threads.create` `{title?}` — Create a new thread
- `threads.messages` `{id}` — Get messages for a thread
- `threads.usage` `{id}` — Get usage/cost for a thread
- `threads.patch` `{id, title}` — Update thread title
- `threads.delete` `{id}` — Delete a thread
- `threads.archive` `{id, archived}` — Archive/unarchive a thread
- `threads.title` `{id, title}` — Set thread title
- `threads.draft` `{id, draft}` — Set/clear thread draft
- `threads.chat` `{id, messages}` — Send a chat message (streaming)

### dev (apps/server/src/router/dev.ts) — development only
- `dev.usersList` — List all users
- `dev.usersImpersonate` `{userId?, email?}` — Get API key for a user
- `dev.usersLogin` `{email, name?}` — Find or create user and get API key

## Prerequisites

- Local dev server must be running (use `.bin/dev start`)
- `gcloud` CLI must be authenticated (`gcloud auth login`)

## When to Use

- Inspecting server state or data through the API
- Testing RPC endpoints
- Debugging API behavior
- Verifying changes to server procedures

## When NOT to Use

- For direct database access (use the `database` skill instead)
- When the dev server is not running
