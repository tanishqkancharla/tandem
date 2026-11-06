# MySQL

`TandemServerMysqlStorage` syncs collections with existing MySQL tables through a `mysql2` pool. It uses the [shared SQL mapping](../sql.md#shared-sql-mapping) and atomic write batches.

The adapter is experimental: records persist, but mutation acknowledgements do not survive a server restart. Read the [SQL limitations](../sql.md#sql-limitations) before choosing it.

## Connect a pool

Install the driver in your application:

```sh
pnpm add mysql2
```

Given the shared `tasks` schema from [Choosing storage](../sql.md#shared-sql-mapping), create a matching table with your migration tool:

```sql
CREATE TABLE tasks (
  id VARCHAR(255) PRIMARY KEY,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE
);
```

Pass a callback pool, without calling `.promise()`:

```ts
import mysql from "mysql2"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import { TandemServerMysqlStorage } from "@tanishqkancharla/tandem-server/sql"
import { schema } from "./schema"

const pool = mysql.createPool(process.env.DATABASE_URL!)
const storage = new TandemServerMysqlStorage({ schema, database: pool })
const server = new TandemServer({ schema, relations: {}, storage })
```

The adapter uses Kysely's MySQL driver for reads and transactions and encodes booleans as `0`/`1`. Other value types need [custom mappings](custom.md#custom-sql-mappings). If differently cased string IDs are distinct in your app, use a primary-key collation that preserves that distinction.

Your application owns the pool. Close it after stopping consumers and calling `server.close()`. Tandem does not create tables or run migrations.
