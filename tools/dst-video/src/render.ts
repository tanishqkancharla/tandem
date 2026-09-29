/**
 * pnpm --filter @tandem/dst-video render [filter] [--still <frame>]
 * Renders every video (or those whose id contains `filter`) to out/<id>.mp4 and out/<id>.gif.
 */
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { bundle } from "@remotion/bundler"
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer"
import { VIDEOS } from "./videos"

const { values, positionals } = parseArgs({ allowPositionals: true, options: { still: { type: "string" } } })
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "out")
mkdirSync(outDir, { recursive: true })

const serveUrl = await bundle({ entryPoint: join(root, "src/index.ts") })
const selected = VIDEOS.filter(({ id }) => !positionals[0] || id.includes(positionals[0]))

for (const { id } of selected) {
	const composition = await selectComposition({ serveUrl, id })
	if (values.still !== undefined) {
		const output = join(outDir, `${id}-${values.still}.png`)
		await renderStill({ serveUrl, composition, output, frame: Number(values.still) })
		console.log(output)
		continue
	}
	await renderMedia({ serveUrl, composition, codec: "h264", crf: 20, outputLocation: join(outDir, `${id}.mp4`) })
	await renderMedia({ serveUrl, composition, codec: "gif", everyNthFrame: 3, scale: 0.75, numberOfGifLoops: null, outputLocation: join(outDir, `${id}.gif`) })
	console.log(`${id}: ${(composition.durationInFrames / composition.fps).toFixed(1)}s`)
}
