# Tandem

A sync engine and database for building collaborative apps.

TODO:
- [x] Basic database
	- [x] getRecord
	- [x] listRecords
	- [x] setRecord
	- [x] removeRecord
- [x] Database work
	- [x] Mutation stream to storage
	- [x] Rollback on failure
- [ ] Storage
	- [x] Mount from storage on initialization
- [ ] Port changes from @triplit/tuple-database to tuple-database proper
- [ ] Make a separate git repo for tandem
- [ ] Set up testing/etc.
	- [ ] Sqlite testing
	- [ ] Mock databases
- [ ] Indexes
	- [ ] Add indexes for all attribute values
	- [ ] Backwards compatibility -- how does mounting from a persisted storage work with new versions?
		- [ ] New database versions
		- [ ] New schema changes
- [ ] Remote
	- [ ] Mutation stream to remote
	- [ ] Mutation tagged with intents
	- [ ] Replay: when fetching new changes, re-apply optimistic/pending mutations on top.
	- [ ] Subscribe to remote
		- [ ] Scan window
	- [ ] Indexes
	- [ ] Migrations
