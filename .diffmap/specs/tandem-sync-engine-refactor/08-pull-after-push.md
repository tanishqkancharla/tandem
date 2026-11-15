# Phase 3: Pull after push

[Phase 2](07-remove-live-payloads.md) left one rule in [[packages/server/src/TandemServer.ts#TandemServer.emitLivePokes]] that needs the server to know who is connected: poke the client that pushed, so it pulls its acknowledgement. A channel fan-out does not know who pushed, so this phase moves that rule to the client.

**Today**

After a push, the client waits for a poke before pulling its acknowledgement. If its event stream is down, the mutation stays pending in the UI until the fallback pull, unless the app's remote pokes itself, as the Cloudflare example does ([[examples/cloudflare/apps/server/src/remote.ts#createRemote]]).

**Proposed**

The client pulls right after a successful push, so its pending mutation clears whether or not any sync engine is connected.

```callstack [SyncEngine.push]
 SyncEngine.push() [[packages/core/src/sync/SyncEngine.ts#SyncEngine.push]]
 ├── response = remote.push({ mutations, clientId })
 ├── record rejections
+└── if response.ok: queuePull() # acknowledge without waiting for a poke
```

`TaskQueue` already coalesces a pull queued during another pull, so a poke that arrives too costs nothing extra. The pusher branch in `emitLivePokes` and the self-poke in both example remotes go away.

A push could instead return the pull's result in its response, saving a round trip. That couples push to the scan window, so this plan keeps them separate; it is an easy later change.

Tests: a core test pushes with no live connection and checks the mutation clears. `dst/` adds runs with the event stream disconnected and asserts that pending mutations clear within one push round trip.

```changes

```
