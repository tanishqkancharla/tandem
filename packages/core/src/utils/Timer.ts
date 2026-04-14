import type { TimerApi } from "@tandem/types"

export class Timer implements TimerApi {
	delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}
}
