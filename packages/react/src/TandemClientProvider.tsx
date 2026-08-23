import {
	TandemClient,
	Transaction,
	type RelationalQuery,
	type RelationalQueryResult,
} from "@tandem/core"
import type {
	AnySchema,
	CollectionName,
	RuntimeRelationsDefinition,
} from "@tandem/types"
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react"

const TandemClientContext = createContext<TandemClient<any, any> | undefined>(
	undefined,
)

export function TandemClientProvider<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
>({
	client,
	ready,
	connect = false,
	fallback = null,
	children,
}: {
	client: TandemClient<Schema, Relations>
	ready?: Promise<unknown>
	connect?: boolean
	fallback?: ReactNode
	children: ReactNode
}) {
	const [isReady, setIsReady] = useState(false)

	useEffect(() => {
		let cancelled = false

		void Promise.resolve(ready ?? client.ready).then(() => {
			if (!cancelled) setIsReady(true)
		})

		return () => {
			cancelled = true
		}
	}, [client, ready])

	useEffect(() => {
		if (!connect) return

		let disposed = false

		void client.connect().catch((error: unknown) => {
			if (!disposed) {
				console.error("Failed to connect tandem client:", error)
			}
		})

		return () => {
			disposed = true
			void client.disconnect().catch((error: unknown) => {
				console.error("Failed to disconnect tandem client:", error)
			})
		}
	}, [client, connect])

	if (!isReady) return fallback

	return (
		<TandemClientContext.Provider value={client}>
			{children}
		</TandemClientContext.Provider>
	)
}

export function useTandemClient<
	Schema extends AnySchema = AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
>(): TandemClient<Schema, Relations> {
	const db = useContext(TandemClientContext)
	if (db === undefined) {
		throw new Error("useTandemClient must be used within TandemClientProvider")
	}
	return db as unknown as TandemClient<Schema, Relations>
}

export interface UseTandemTransaction<Schema extends AnySchema> {
	<Args extends unknown[]>(
		callback: (tx: Transaction<Schema>, ...args: Args) => void,
	): (...args: Args) => void
}

export function useTandemTransaction<
	Schema extends AnySchema = AnySchema,
	Args extends unknown[] = unknown[],
>(
	callback: (tx: Transaction<Schema>, ...args: Args) => void,
): (...args: Args) => void {
	const db = useTandemClient<Schema>()

	return useCallback(
		(...args: Args) => {
			const tx = db.transact()
			callback(tx, ...args)
			void db.commit(tx).then(() => db.flushStorage())
		},
		[callback, db],
	)
}

export interface UseTandemQuery<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
> {
	<Query extends RelationalQuery<Schema, Relations>>(
		query: Query | undefined,
	): RelationalQueryResult<Schema, Relations, Query> | undefined
}

export function useTandemQuery<
	Schema extends AnySchema = AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
	Query extends RelationalQuery<Schema, Relations> = RelationalQuery<
		Schema,
		Relations
	>,
>(
	query: Query | undefined,
): RelationalQueryResult<Schema, Relations, Query> | undefined {
	const db = useTandemClient<Schema, Relations>()
	const [value, setValue] = useState<
		RelationalQueryResult<Schema, Relations, Query> | undefined
	>(() => {
		if (query === undefined) return undefined
		return db.query(query)
	})

	useEffect(() => {
		if (query === undefined) {
			setValue(undefined)
			return undefined
		}

		const { destroy, result } = db.subscribe(query, (nextValue) => {
			setValue(nextValue)
		})

		setValue(result)

		return () => {
			destroy()
		}
	}, [db, query])

	return value
}

export function useEntity<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	collection: Collection,
	id: Schema[Collection]["id"] | undefined,
): Schema[Collection] | undefined {
	const query = useMemo(
		() =>
			id === undefined
				? undefined
				: ({
						collection,
						where: { id },
					} as unknown as RelationalQuery<
						Schema,
						RuntimeRelationsDefinition<Schema>
					>),
		[collection, id],
	)
	const rows = useTandemQuery(query)
	if (rows === undefined) return undefined
	return rows[0] as unknown as Schema[Collection] | undefined
}
