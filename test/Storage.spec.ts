import { describe, expect, test, vi } from "vitest"
import { Storage } from "../src/storage/Storage"
import type { StorageApi } from "../src/types"

describe("Storage", () => {
	test("commit failure calls onFailure and rethrows", async () => {
		const error = new Error("commit failed")
		const adapter: StorageApi = {
			commit: vi.fn().mockRejectedValue(error),
			scan: vi.fn().mockResolvedValue([]),
			clear: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		}
		const onFailure = vi.fn()
		const storage = new Storage(adapter, onFailure)

		await expect(storage.commit({ set: [] })).rejects.toBe(error)
		expect(onFailure).toHaveBeenCalledWith(error)
	})
})
