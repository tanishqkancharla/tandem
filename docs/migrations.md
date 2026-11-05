# Migrations

Use your application's database migration tool to change tables and existing rows. Update Tandem's record types, runtime schema, SQL mappings or codecs, and affected mutations alongside that change. Tandem does not run migrations or negotiate application schema versions.

A simple policy for breaking changes is to reject sync requests from incompatible clients. Your app decides how to display that state; a reload prompt is optional.

Tandem does not detect schema incompatibility automatically. Without an application check, it still processes requests: a mismatch might cause validation or decoding errors, or an old write might succeed with an unwanted data shape.

## Reject incompatible clients

Keep a sync protocol version in the client release and the server's deployed code or configuration. No database table or Tandem extension is needed. Change it when the sync contract becomes incompatible, rather than on every deployment. Send the client's version with every sync request and check it before processing pushes, pulls, or opening event streams:

```ts
// Server: mount this on both /api/tandem and /api/tandem/events.
const REQUIRED_SYNC_VERSION = "2"

function tandemEndpoint(request: Request) {
	const version = new URL(request.url).searchParams.get("syncVersion")
	if (version !== REQUIRED_SYNC_VERSION) {
		return Response.json({ error: "incompatible-client" }, { status: 409 })
	}
	return syncEndpoint(request) // Your authenticated handler.
}
```

A missing version fails the check too. This version is an application convention, separate from Tandem's cookies and mutation IDs. Keep the [permission checks](permissions.md) in place; the version is not a credential.

On the client, use that release's version for both HTTP requests and the event URL:

```ts
// Client: keep this fixed for the code and data shape in this release.
const SYNC_VERSION = "2"
const syncUrl = `/api/tandem?syncVersion=${SYNC_VERSION}`
const eventsUrl = `/api/tandem/events?syncVersion=${SYNC_VERSION}&clientId=${encodeURIComponent(clientId)}`

// Inside your push/pull request function:
const response = await fetch(syncUrl, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ action, args }),
})
if (response.status === 409) {
	onIncompatibleClient() // App callback: expose this state to the UI.
	return { error: "unavailable", message: "Incompatible sync version" } as const
}
```

Treat `409` as a failed request, not a Tandem response. The server blocks data exchange; local records and pending writes remain on the device. This does not permanently disconnect the client, so later attempts are rejected too. Your app can display a sync error, disconnect to stop further attempts, or offer an update. Keep the version fixed to the code that understands that data shape.

`onIncompatibleClient` is your callback, not a Tandem API. Use it to set application state and show a notice such as "This app version can no longer sync." If an updated client is available, the UI can offer a reload:

```tsx
<button onClick={() => window.location.reload()}>Reload to update</button>
```

Ship that detection with the client before relying on it for a breaking release. A client without the callback is still blocked by the server, but cannot show this notice. Reloading helps only when the browser loads a compatible release; handle the old cache as described below.

Pass `eventsUrl` to `connectTandemEventSource`. `EventSource` hides HTTP response statuses, so detect incompatibility through a fetch request, such as a pull or a version probe before connecting.

## Deploy the change

1. Pause sync traffic and stop background writers before applying an incompatible database migration. Close existing event streams; checking new requests does not stop a stream that is already open.
2. Migrate the database and deploy server code with the updated Tandem schema, mappings, mutations, and required protocol version. Retire old server instances before reopening sync.
3. Deploy the matching client and resume sync. Old clients receive `409`; updated clients use the new version.

The [SQL adapter](sql.md) reads current rows on each pull; there is no separate in-memory copy to migrate. Deploy new code for schema and mapping changes. Restarting clears remembered client views, which the next pull rebuilds. Direct SQL changes do not notify clients, so reconnect them after migration.

SQL mutation acknowledgements currently live in memory, so restarts can replay writes or cause mutation gaps. Version checks do not fix that [storage limitation](sql.md).

## Handle the client's old cache

Updating application code does not convert IndexedDB records or pending writes. For an incompatible cache, start the new release with a new database name:

```ts
const client = new TandemClient({
	schema,
	remote,
	clientStorage: new TandemClientIndexedDbStorage({
		dbName: `tasks:${userId}:${workspaceId}:v2`,
		schema,
	}),
})
```

Version an explicit `tabs.name` too, if you set one. The new replica starts empty; subscriptions pull current records from the server. The old database remains separate and can be deleted later by your app.

This does not transfer unsynced work. Decide whether users must sync before the maintenance window, can export and reapply their edits, or may discard them. Tandem has no built-in migration for pending writes. New code must not silently send incompatible cached mutations under the new protocol version.

Check the upgrade with an old open tab and an offline client with pending writes, as well as a fresh install. Verify that old requests are rejected, old streams stop, and the updated client loads the migrated records.
