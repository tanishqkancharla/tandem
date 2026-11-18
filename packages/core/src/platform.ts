import type { TandemEventSourceConstructor } from "./sync/TandemEventSource.js"
import type {
	TabChannelApi,
	TabEnvironmentApi,
	TabLocksApi,
} from "./tabs/TabEnvironment.js"

// The only module in shared core that reads runtime globals. Each export
// returns undefined where the API is missing, so callers fall back.

export type VisibilityDocument = {
	visibilityState: string
	addEventListener(type: "visibilitychange", listener: () => void): void
	removeEventListener(type: "visibilitychange", listener: () => void): void
}

type PlatformGlobals = {
	document?: VisibilityDocument
	navigator?: { locks?: TabLocksApi }
	BroadcastChannel?: new (name: string) => TabChannelApi
	EventSource?: TandemEventSourceConstructor<unknown>
}

const platform = globalThis as PlatformGlobals

/**
 * Web Locks and BroadcastChannel in a browser document, or undefined elsewhere.
 * Node also has both APIs, but its processes do not share IndexedDB.
 */
export function browserTabEnvironment(): TabEnvironmentApi | undefined {
	const locks = platform.navigator?.locks
	const Channel = platform.BroadcastChannel
	if (!platform.document || !locks || !Channel) return undefined
	return {
		locks: { request: (name, callback) => locks.request(name, callback) },
		openChannel: (name) => new Channel(name),
	}
}

/** The page's document, for its visibility, or undefined outside a page. */
export function visibilityDocument(): VisibilityDocument | undefined {
	return platform.document
}

export function globalEventSource<Init>():
	| TandemEventSourceConstructor<Init>
	| undefined {
	return platform.EventSource as TandemEventSourceConstructor<Init> | undefined
}
