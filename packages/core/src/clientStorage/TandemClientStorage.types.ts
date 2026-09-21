import { TandemClient } from "@tanishqkancharla/tandem-core"
import type { TandemClientStorageApi } from "@tanishqkancharla/tandem-core"

type AppSchema = {
	users: { id: string; name: string }
}

type OtherSchema = {
	threads: { id: number; title: string }
}

declare const appStorage: TandemClientStorageApi<AppSchema>
declare const otherStorage: TandemClientStorageApi<OtherSchema>

new TandemClient<AppSchema, {}>({ clientStorage: appStorage })

// @ts-expect-error A client cache must store tuples for the client's schema.
new TandemClient<AppSchema, {}>({ clientStorage: otherStorage })
