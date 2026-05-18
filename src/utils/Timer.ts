import type { TimerApi } from "../types"

export class Timer implements TimerApi {
	delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}
}
