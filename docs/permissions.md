# Authentication and permissions

Enforce permissions in your application's sync endpoints: authenticate the caller, restrict what they can read, and check what they can write. Tandem has no built-in users, roles, or read permission rules.

Protect all three operations: `push`, `pull`, and the live event connection. Live events can carry records, so authenticating only the HTTP push and pull routes is insufficient.

## Example: sync one authorized workspace

A simple setup gives each workspace its own `TandemServer` and isolated storage. Every member may read that workspace's synced records. The endpoint checks the session and routes requests to the right server:

```ts
import { createTandemEventStreamResponse } from "@tanishqkancharla/tandem-server"

async function syncEndpoint(request: Request) {
	const session = await authenticate(request)
	if (!session) return new Response("Sign in required", { status: 401 })
	if (!(await isWorkspaceMember(session)))
		return new Response("No workspace access", { status: 403 })

	const input = await readSyncRequest(request)
	if (input instanceof Error)
		return new Response("Invalid request", { status: 400 })
	if (!(await ownsClientId(session, input.clientId)))
		return new Response("Invalid client identity", { status: 403 })

	const server = await workspaceServer(session.workspaceId)
	if (input.action === "connect") {
		return createTandemEventStreamResponse({
			remote: server,
			clientId: input.clientId,
			schema,
			signal: request.signal,
		})
	}
	if (input.action === "push") {
		return Response.json(
			await server.push(input.args, {
				context: session,
				allowOps: false,
			}),
		)
	}
	return Response.json(await server.pull(input.args))
}
```

Mount this on your push/pull and event routes. The helpers belong to your app: authenticate the session, check current membership, and verify your server-held binding between the client ID, user, and workspace. `readSyncRequest` validates the envelope and client ID, decodes push mutations, and returns a `push`, `pull`, or `connect` action. See [Server transport codecs](server.md#transport-codecs) for codecs.

`workspaceServer` reuses a server with isolated storage and registered named mutations. Separate instances over one unfiltered database do not isolate records. Scope client storage and tab sharing by user and workspace too.

For row-level access within a workspace, enforce the allowed filters on the server before calling `pull`, including every relation include. A client-supplied `where` or `select` is not a permission rule; sync sends full records. Filtering the returned patch is too late because later live payloads use the view Tandem recorded during the pull.

## Check writes with named mutation hooks

A named mutation is a shared operation such as `renameTask({ id, text })`, registered on client and server. Its server-only `authorize` hook checks the session and current records before committing. Return an `Error` to refuse it; `false` does not refuse it. See the [hook example](agent-chat.md#register-the-server-once).

Read access does not grant write access. The example uses `allowOps: false` so raw writes cannot bypass these hooks. Check current permissions when queued offline writes arrive too.

## When access changes

If an enforced query no longer returns a record, the next successful pull removes it from the client's synced view and updates subscribed UI. For example, a server-enforced `ownerId` filter excludes a task after ownership changes; changing that task through Tandem triggers a pull, which sends its removal.

For membership changes outside those queries, your app must trigger the refresh and end affected streams before they send more data. Track an abort signal per connection and combine it with `request.signal` above; recheck access on reconnection.

A `403` or closed stream does not clear downloaded data. On complete loss of access, hide the workspace and close its client. On partial loss, deliver the newly authorized view to remove excluded records. Pending edits may remain until rejected and acknowledged; offline devices cannot receive revocation immediately.
