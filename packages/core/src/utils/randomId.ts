export type RngApi = {
	randomId: () => string
}

export function randomNumber(): number {
	return Math.floor(Math.random() * 10000000000)
}

export function randomId(): string {
	return randomNumber().toString()
}
