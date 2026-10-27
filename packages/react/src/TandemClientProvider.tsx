import {
	TandemClient,
	Transaction,
	type AnySchema,
	type CollectionName,
	type RelationalQuery,
	type RelationalQueryResult,
	type AggregateQuery,
	type AggregateGroupFields,
	type GroupedAggregateRow,
	type AnyRelations,
} from "@tanishqkancharla/tandem-core"
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react"

const TandemClientContext = createContext<TandemClient<any, any> | undefined>(
	undefined,
)

export type TandemClientProviderProps<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> = {
	client: TandemClient<Schema, Relations>
	ready?: Promise<unknown>
	connect?: boolean
	fallback?: ReactNode
	children: ReactNode
}

export function TandemClientProvider<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
>({
	client,
	ready,
	connect = false,
	fallback = null,
	children,
}: TandemClientProviderProps<Schema, Relations>) {
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
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
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
			void db.commit(tx).then(() => db.flushClientStorage())
		},
		[callback, db],
	)
}

export interface UseTandemQuery<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> {
	<
		Collection extends CollectionName<Schema>,
		const Keys extends readonly AggregateGroupFields<Schema[Collection]>[],
		Result extends Record<string, unknown>,
	>(
		query:
			| (AggregateQuery<Schema, Collection, Result, Keys> & { groupBy: Keys })
			| undefined,
	): GroupedAggregateRow<Schema[Collection], Keys, Result>[] | undefined
	<Collection extends CollectionName<Schema>, Result>(
		query: AggregateQuery<Schema, Collection, Result> | undefined,
	): Result | undefined
	<Query extends RelationalQuery<Schema, Relations>>(
		query: Query | undefined,
	): RelationalQueryResult<Schema, Relations, Query> | undefined
}

export function useTandemQuery<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	const Keys extends readonly AggregateGroupFields<Schema[Collection]>[],
	Result extends Record<string, unknown>,
>(
	query:
		| (AggregateQuery<Schema, Collection, Result, Keys> & { groupBy: Keys })
		| undefined,
): GroupedAggregateRow<Schema[Collection], Keys, Result>[] | undefined
export function useTandemQuery<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	Result,
>(
	query: AggregateQuery<Schema, Collection, Result> | undefined,
): Result | undefined
export function useTandemQuery<
	Schema extends AnySchema = AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations> = RelationalQuery<
		Schema,
		Relations
	>,
>(
	query: Query | undefined,
): RelationalQueryResult<Schema, Relations, Query> | undefined
export function useTandemQuery(
	query:
		| RelationalQuery<AnySchema, AnyRelations<AnySchema>>
		| AggregateQuery<AnySchema, string, unknown, any>
		| undefined,
): unknown {
	const db = useTandemClient()
	const [value, setValue] = useState<unknown>(() => {
		if (query === undefined) return undefined
		return db.query(query as never)
	})

	const queryRef = useRef(query)
	queryRef.current = query
	const queryKey =
		query === undefined
			? undefined
			: JSON.stringify({
					...query,
					aggregate: "aggregate" in query ? true : undefined,
				})
	const subscriptionRef = useRef<{ refresh?: () => void } | undefined>(
		undefined,
	)
	const ownUpdate = useRef(false)

	useEffect(() => {
		const currentQuery = queryRef.current
		if (currentQuery === undefined) {
			setValue(undefined)
			return undefined
		}

		const subscriptionQuery =
			"aggregate" in currentQuery
				? {
						...currentQuery,
						aggregate: (rows: readonly unknown[]) =>
							(queryRef.current as typeof currentQuery).aggregate(
								rows as never,
							),
					}
				: currentQuery
		const subscription = db.subscribe(
			subscriptionQuery as never,
			(nextValue) => {
				ownUpdate.current = true
				setValue((previous: unknown) =>
					JSON.stringify(previous) === JSON.stringify(nextValue)
						? previous
						: nextValue,
				)
			},
		) as { result: unknown; destroy: () => void; refresh?: () => void }
		const { destroy, result } = subscription
		subscriptionRef.current = subscription

		setValue((previous: unknown) =>
			JSON.stringify(previous) === JSON.stringify(result) ? previous : result,
		)

		return () => {
			subscriptionRef.current = undefined
			destroy()
		}
	}, [db, queryKey])
	useEffect(() => {
		if (ownUpdate.current) {
			ownUpdate.current = false
			return
		}
		if (query && "aggregate" in query) subscriptionRef.current?.refresh?.()
	})

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
					} as unknown as RelationalQuery<Schema, AnyRelations<Schema>>),
		[collection, id],
	)
	const rows = useTandemQuery(query)
	if (rows === undefined) return undefined
	return rows[0] as unknown as Schema[Collection] | undefined
}
