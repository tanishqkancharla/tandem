# Controlled sync ordering

[ordering.spec.ts](ordering.spec.ts) uses Gatekeeper to test real Tandem clients
against their shared in-memory server. The client fixture forwards transactions,
commits, and pulls to Tandem and exposes a fixed todo query. The database, sync
queue, subscriptions, notifications, and conflict resolution all run normally.

The server fixture includes an in-process transport that binds notification
callbacks to their registration context. Otherwise a server poke inherits the
writing client's Gatekeeper context and incorrectly gates another client's pull
as part of that write. Tests still interact only with client1, client2, and server;
they do not choose RPC methods or inspect protocol payloads.

Tandem serializes pushes and pulls within each client. Holding a client's push
also prevents that client from processing its next pull. These tests control
ordering across clients without bypassing that queue. For example, Client2 can
read a saved record while Client1's acknowledgement remains held.
