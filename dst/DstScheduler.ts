import type { CallHandle } from "@tanishqkancharla/gatekeeper"
import type { SimPrng } from "./SimPrng.js"

export interface DstTraceEvent {
	step: number
	action: string
	detail?: Record<string, unknown>
}

export class DstScheduler {
	private readonly pendingCalls: {
		id: number
		label: string
		handle: CallHandle<unknown>
	}[] = []
	private nextCallId = 1
	readonly trace: DstTraceEvent[] = []

	constructor(private readonly rng: SimPrng) {}

	track<T>(label: string, handle: CallHandle<T>): CallHandle<T> {
		this.pendingCalls.push({
			id: this.nextCallId++,
			label,
			handle: handle as CallHandle<unknown>,
		})
		return handle
	}

	get pendingCount(): number {
		return this.pendingCalls.length
	}

	/**
	 * Step one pending call chosen pseudo-randomly
	 */
	async stepOne(stepIndex: number): Promise<boolean> {
		if (this.pendingCalls.length === 0) return false

		const idx = this.rng.int(0, this.pendingCalls.length - 1)
		const item = this.pendingCalls[idx]

		try {
			// Advance to completion or next boundary
			await item.handle.continueToCompletion()
			this.trace.push({
				step: stepIndex,
				action: "STEP_COMPLETE",
				detail: { callId: item.id, label: item.label },
			})
		} catch (error) {
			this.trace.push({
				step: stepIndex,
				action: "STEP_ERROR",
				detail: { callId: item.id, label: item.label, error: String(error) },
			})
		} finally {
			this.pendingCalls.splice(idx, 1)
		}

		return true
	}

	/**
	 * Inject a simulated fault into one randomly selected pending call
	 */
	async injectFault(stepIndex: number, error: Error): Promise<boolean> {
		if (this.pendingCalls.length === 0) return false

		const idx = this.rng.int(0, this.pendingCalls.length - 1)
		const item = this.pendingCalls[idx]

		try {
			await item.handle.fail(error)
			this.trace.push({
				step: stepIndex,
				action: "INJECT_FAULT",
				detail: { callId: item.id, label: item.label, error: error.message },
			})
		} catch (e) {
			this.trace.push({
				step: stepIndex,
				action: "FAULT_INJECTION_FAILED",
				detail: { callId: item.id, label: item.label, error: String(e) },
			})
		} finally {
			this.pendingCalls.splice(idx, 1)
		}

		return true
	}

	/**
	 * Drain remaining calls to settle during quiescence
	 */
	async drainAll(): Promise<void> {
		while (this.pendingCalls.length > 0) {
			const item = this.pendingCalls.shift()!
			try {
				await item.handle.continueToCompletion()
			} catch {
				// Ignore errors during final drain of rejected calls
			}
		}
	}
}
