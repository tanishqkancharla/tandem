export type TimerApi = {
	waitForNextTick: () => Promise<void>
}

export class Timer implements TimerApi {
	private readonly interval: number

	constructor({ interval }: { interval: number }) {
		this.interval = interval
	}

	waitForNextTick(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, this.interval))
	}
}
