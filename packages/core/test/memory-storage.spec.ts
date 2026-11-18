import { TandemClientMemoryStorage } from "@tanishqkancharla/tandem-core"
import { describeClientStorageContract } from "./clientStorageContract.js"

describeClientStorageContract(
	"TandemClientMemoryStorage",
	({ dbName, ...options }) =>
		new TandemClientMemoryStorage({ name: dbName, ...options }),
)
