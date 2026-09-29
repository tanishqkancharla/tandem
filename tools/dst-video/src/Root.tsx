import { Composition } from "remotion"
import { IssueVideo, totalDuration } from "./Video"
import { VIDEOS } from "./videos"

export const Root = () => (
	<>
		{VIDEOS.map(({ id, props }) => (
			<Composition key={id} id={id} component={IssueVideo} width={1280} height={720} fps={30} durationInFrames={totalDuration(props)} defaultProps={props} />
		))}
	</>
)
