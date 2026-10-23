import { createTandemCoordinator } from "@tanishqkancharla/tandem-cloudflare"

const coordinator = createTandemCoordinator()

export const TandemCoordinator = coordinator.TandemCoordinator
export default coordinator.worker
