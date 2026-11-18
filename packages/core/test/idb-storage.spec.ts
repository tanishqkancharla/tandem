import { TandemClientIndexedDbStorage } from "@tanishqkancharla/tandem-core/idb"
import * as fakeIndexedDb from "fake-indexeddb"
import { afterAll, beforeAll } from "vitest"
import { describeClientStorageContract } from "./clientStorageContract.js"

const { default: _default, ...indexedDbGlobals } = fakeIndexedDb

// Tests share one module graph, so install IndexedDB only while this file
// runs; any other test that reaches for it fails.
beforeAll(() => {
	Object.assign(globalThis, indexedDbGlobals)
})

afterAll(() => {
	for (const name of Object.keys(indexedDbGlobals)) {
		Reflect.deleteProperty(globalThis, name)
	}
})

describeClientStorageContract(
	"TandemClientIndexedDbStorage",
	(options) => new TandemClientIndexedDbStorage(options),
)
