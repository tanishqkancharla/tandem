-- The app's own table. Tandem reads and writes these rows through the bridge;
-- other app code can keep using plain SQL.
CREATE TABLE todos (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	done INTEGER NOT NULL DEFAULT 0,
	createdAt INTEGER NOT NULL
);

-- Each Tandem client's last applied mutation, committed atomically with its writes.
CREATE TABLE tandem_clients (
	client_id TEXT PRIMARY KEY,
	last_mutation_id INTEGER NOT NULL CHECK (last_mutation_id > 0)
);
