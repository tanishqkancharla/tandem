export {
	executeQueryAsync,
	executeQuerySync,
	executeScanWindowAsync,
	InvalidScanWindowError,
	scanWindowOffsetCollections,
	selectScanWindowRecordsAsync,
} from "./query/executeQuery.js"
export type { ScanWindowRecord } from "./query/executeQuery.js"
export { collectionIdsEqual, collectionIdToTuple } from "./schema/Schema.js"
export {
	UpdatePayloadError,
	validateUpdatePayload,
} from "./transaction/Transaction.js"
// In-memory tabs, for tests and hosts outside a browser document.
export { InMemoryTab, InMemoryTabs } from "./tabs/TabEnvironment.js"
export type {
	TabChannelApi,
	TabEnvironmentApi,
	TabMessageListener,
} from "./tabs/TabEnvironment.js"
