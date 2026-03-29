---
name: database
description: |
  Execute SQL queries against the agent database. Use when inspecting database schema, tables, or data,
  verifying data after changes, or debugging database-related issues.
---

# Database Access

Use the `.agents/skills/database/cli.ts` CLI to execute SQL queries against the agent database.

## Connection Details

- **Local database**: `postgresql://halo_agent:password@localhost:5433/halo_agent` (full read/write)
- **Production database**: Cloud SQL instance `halo-relay:us-central1:halo-agent-db` (read-only, IAM auth)

## Schema

The database schema is defined in `packages/db/src/schema.ts` and `packages/db/src/schema/auth.ts`. Read these files before writing queries.

Key tables: `threads`, `user`, `session`, `account`, `verification`, `apikey`.

## Commands

```bash
# Query local database (full access)
.agents/skills/database/cli.ts query "SELECT * FROM threads LIMIT 5"

# Query production database (read-only)
.agents/skills/database/cli.ts query "SELECT * FROM threads LIMIT 5" --target production

# List tables
.agents/skills/database/cli.ts query "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"

# Describe a table
.agents/skills/database/cli.ts query "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'threads' ORDER BY ordinal_position"
```

## When to Use

- Inspecting database schema, tables, or data
- Verifying data after making changes in development
- Debugging database-related issues
- Understanding the current state of the database

## When NOT to Use

- When you can find the information in the codebase or schema files
- For bulk production modifications (production is always read-only)

## Important Notes

1. **Production is always read-only** — enforced at the session level
2. **Local has full access** — read and write operations allowed
3. Always read the schema files in `packages/db/src/schema/` before writing queries
4. The local database requires Docker to be running (`docker compose up postgres`)
