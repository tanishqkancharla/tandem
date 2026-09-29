import type { CSSProperties, ReactNode } from "react"
import { AbsoluteFill, interpolate, Series, spring, useCurrentFrame, useVideoConfig } from "remotion"
import type { ClientName, ClientView, Message, Party, Records, Snapshot } from "./sim"
import type { Frame, VideoProps } from "./videos"

const C = {
	bg: "#f6f6f3", card: "#ffffff", ink: "#1d1d1f", muted: "#6b6b70", line: "#e2e2dd",
	add: "#dcf3e3", addInk: "#137333", del: "#fde2e1", delInk: "#b3261e", chg: "#fff1c2",
	accent: "#3b5bdb", accentSoft: "#edf1ff", term: "#16181d",
}
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`
const MONO = `ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`

// ─── Timing ───────────────────────────────────────────────────────────────
export const TIMING = { title: 75, intro: 240, verdict: 120, stepLead: 24, perMessage: 26, stepHold: 84 }
export const stepDuration = (frame: Frame) =>
	TIMING.stepLead + frame.snapshot.messages.length * TIMING.perMessage + TIMING.stepHold
export const totalDuration = (props: VideoProps) =>
	TIMING.title + TIMING.intro + props.frames.reduce((sum, f) => sum + stepDuration(f), 0) + TIMING.verdict

const fadeIn = (frame: number, start = 0, length = 12) =>
	interpolate(frame, [start, start + length], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

// ─── Top-level ────────────────────────────────────────────────────────────
export const IssueVideo = (props: VideoProps) => (
	<AbsoluteFill style={{ background: C.bg, fontFamily: FONT, color: C.ink }}>
		<style>{"*, *::before, *::after { box-sizing: border-box; }"}</style>
		<Header {...props} />
		<AbsoluteFill style={{ top: 64, height: "auto" }}>
			<Series>
				<Series.Sequence durationInFrames={TIMING.title}>
					<TitleCard {...props} />
				</Series.Sequence>
				<Series.Sequence durationInFrames={TIMING.intro}>
					{props.mode === "failure" ? <TerminalCard {...props} /> : <RulesCard {...props} />}
				</Series.Sequence>
				{props.frames.map((frame, index) => (
					<Series.Sequence key={index} durationInFrames={stepDuration(frame)}>
						<StepScene frame={frame} prev={props.frames[index - 1]?.snapshot} index={index} total={props.frames.length} mode={props.mode} />
					</Series.Sequence>
				))}
				<Series.Sequence durationInFrames={TIMING.verdict}>
					<VerdictCard {...props} />
				</Series.Sequence>
			</Series>
		</AbsoluteFill>
	</AbsoluteFill>
)

function Header({ issue, title, mode }: VideoProps) {
	const failure = mode === "failure"
	return (
		<div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 64, background: C.card, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", padding: "0 32px", gap: 14 }}>
			<span style={{ fontWeight: 700, fontSize: 22, color: C.muted }}>#{issue}</span>
			<span style={{ fontWeight: 600, fontSize: 22 }}>{title}</span>
			<span style={{ marginLeft: "auto", fontSize: 15, fontWeight: 700, letterSpacing: 0.5, padding: "6px 14px", borderRadius: 999, background: failure ? C.del : C.add, color: failure ? C.delInk : C.addInk }}>
				{failure ? "TODAY · main" : "PROPOSED FIX · simulated"}
			</span>
		</div>
	)
}

function TitleCard({ issue, title, subtitle, mode }: VideoProps) {
	const frame = useCurrentFrame()
	const { fps } = useVideoConfig()
	const s = spring({ frame, fps, config: { damping: 200 } })
	return (
		<AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: s, transform: `translateY(${(1 - s) * 20}px)` }}>
			<div style={{ fontSize: 28, color: mode === "failure" ? C.delInk : C.addInk, fontWeight: 700, marginBottom: 12 }}>
				{mode === "failure" ? "The bug" : "The proposed fix"}
			</div>
			<div style={{ fontSize: 52, fontWeight: 700, textAlign: "center", maxWidth: 1080, lineHeight: 1.15 }}>
				#{issue} · {title}
			</div>
			<div style={{ fontSize: 26, color: C.muted, marginTop: 18 }}>{subtitle}</div>
		</AbsoluteFill>
	)
}

// ─── The failing task ─────────────────────────────────────────────────────
function TerminalCard({ terminal }: VideoProps) {
	const frame = useCurrentFrame()
	if (!terminal) return null
	const typed = terminal.command.slice(0, Math.floor(interpolate(frame, [10, 55], [0, terminal.command.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })))
	const lines = [...terminal.output, "exit code 1"]
	return (
		<AbsoluteFill style={{ padding: "36px 60px", gap: 18 }}>
			<div style={{ fontSize: 26, fontWeight: 600, opacity: fadeIn(frame) }}>
				The failing task: replaying the recorded DST run <span style={{ color: C.muted, fontWeight: 400 }}>({terminal.commit})</span>
			</div>
			<div style={{ background: C.term, borderRadius: 14, padding: "26px 30px", fontFamily: MONO, fontSize: 21, lineHeight: 1.6, color: "#e6edf3", boxShadow: "0 10px 30px rgba(0,0,0,.18)" }}>
				<div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
					{["#ff5f57", "#febc2e", "#28c840"].map((color) => <span key={color} style={{ width: 13, height: 13, borderRadius: "50%", background: color }} />)}
				</div>
				<div>
					<span style={{ color: "#7ee787" }}>$ </span>{typed}
					{frame < 60 && frame % 20 < 10 ? <span style={{ background: "#e6edf3" }}>&nbsp;</span> : null}
				</div>
				{lines.map((line, i) => {
					const start = 70 + i * 16
					const red = /disagrees|actual|exit code/.test(line)
					const green = /expected/.test(line)
					return (
						<div key={i} style={{ opacity: fadeIn(frame, start, 6), whiteSpace: "pre", color: red ? "#ff7b72" : green ? "#7ee787" : "#c9d1d9", fontWeight: red && i === 1 ? 700 : 400 }}>
							{line}
						</div>
					)
				})}
			</div>
			<div style={{ fontSize: 22, color: C.muted, opacity: fadeIn(frame, 150) }}>
				The recorded run interleaves {terminal.steps} steps of writes, pushes, pulls, and pokes. Next: the same bug, reduced to the steps that matter.
			</div>
		</AbsoluteFill>
	)
}

// ─── The proposed rules ───────────────────────────────────────────────────
function RulesCard({ rules = [], diff = "" }: VideoProps) {
	const frame = useCurrentFrame()
	return (
		<AbsoluteFill style={{ padding: "30px 60px", gap: 18, flexDirection: "row" }}>
			<div style={{ flex: "0 0 400px", display: "flex", flexDirection: "column", gap: 14 }}>
				<div style={{ fontSize: 26, fontWeight: 600, opacity: fadeIn(frame) }}>The new rules</div>
				{rules.map((rule, i) => (
					<div key={i} style={{ opacity: fadeIn(frame, 15 + i * 18), background: C.card, border: `1px solid ${C.line}`, borderLeft: `5px solid ${C.addInk}`, borderRadius: 10, padding: "14px 16px", fontSize: 21, lineHeight: 1.35 }}>
						{rule}
					</div>
				))}
			</div>
			<div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, opacity: fadeIn(frame, 40) }}>
				<div style={{ fontSize: 26, fontWeight: 600 }}>What changes</div>
				<div style={{ background: C.term, borderRadius: 14, padding: "20px 24px", fontFamily: MONO, fontSize: 18, lineHeight: 1.6, color: "#c9d1d9" }}>
					{diff.split("\n").map((line, i) => {
						const add = line.startsWith("+"), del = line.startsWith("-")
						return (
							<div key={i} style={{ whiteSpace: "pre", color: add ? "#7ee787" : del ? "#ff7b72" : line.trim() && !line.startsWith(" ") ? "#e6edf3" : "#c9d1d9", background: add ? "rgba(46,160,67,.16)" : del ? "rgba(248,81,73,.14)" : "transparent", fontWeight: !add && !del && line.trim() && !line.startsWith(" ") ? 700 : 400 }}>
								{line || " "}
							</div>
						)
					})}
				</div>
			</div>
		</AbsoluteFill>
	)
}

// ─── Scenario step ────────────────────────────────────────────────────────
const X: Record<Party, number> = { client1: 223, server: 640, client2: 1057 }

function StepScene({ frame: step, prev, index, total, mode }: { frame: Frame; prev?: Snapshot; index: number; total: number; mode: VideoProps["mode"] }) {
	const frame = useCurrentFrame()
	const snap = step.snapshot
	const messagesEnd = TIMING.stepLead + snap.messages.length * TIMING.perMessage
	const settled = frame >= messagesEnd
	const shown = settled || !prev ? snap : { ...prev, messages: snap.messages, notes: [] }
	const border = step.status === "bad" ? C.delInk : step.status === "good" ? C.addInk : C.line
	return (
		<AbsoluteFill style={{ padding: "18px 32px 22px", gap: 12 }}>
			<div style={{ display: "flex", alignItems: "baseline", gap: 16, opacity: fadeIn(frame, 0, 8) }}>
				<span style={{ fontSize: 16, color: C.muted, fontWeight: 600, letterSpacing: 0.4 }}>
					{index === 0 ? "SETUP" : `STEP ${index} OF ${total - 1}`}
				</span>
				<span style={{ fontSize: 28, fontWeight: 700 }}>{step.label}</span>
				<span style={{ marginLeft: "auto", fontSize: 15, color: C.muted }}>
					{mode === "failure" ? "Simplified from the recorded run" : "Same scenario, proposed rules"}
				</span>
			</div>

			<div style={{ position: "relative", height: 46 }}>
				<div style={{ position: "absolute", top: 22, left: X.client1, right: 1280 - 64 - X.client2, height: 2, background: C.line }} />
				{snap.messages.map((message, i) => (
					<MessagePill key={i} message={message} start={TIMING.stepLead + i * TIMING.perMessage} last={i === snap.messages.length - 1} frame={frame} />
				))}
			</div>

			<div style={{ display: "flex", gap: 16, flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
				<ClientCard name="client1" view={shown.clients.client1} prev={settled ? prev?.clients.client1 : undefined} glow={settled && step.focus === "client1" ? step.status : ""} />
				<ServerCard records={shown.server.records} prev={settled ? prev?.server.records : undefined} facts={shown.server.facts} />
				<ClientCard name="client2" view={shown.clients.client2} prev={settled ? prev?.clients.client2 : undefined} glow={settled && step.focus === "client2" ? step.status : ""} />
			</div>

			<div style={{ height: 104, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, justifyContent: "flex-end" }}>
				{settled && snap.notes.map((note, i) => (
					<div key={i} style={{
						opacity: fadeIn(frame, messagesEnd + i * 8, 8), fontSize: 20, padding: "10px 16px", borderRadius: 10,
						background: note.kind === "bad" ? C.del : note.kind === "good" ? C.add : C.card,
						color: note.kind === "bad" ? C.delInk : note.kind === "good" ? C.addInk : C.ink,
						border: `1px solid ${note.kind === "info" ? C.line : "transparent"}`, fontWeight: note.kind === "info" ? 400 : 600,
					}}>
						{note.kind === "bad" ? "✗ " : note.kind === "good" ? "✓ " : ""}{note.text}
					</div>
				))}
			</div>
			<div style={{ position: "absolute", inset: 0, pointerEvents: "none", border: `6px solid ${border}`, opacity: settled && step.status ? 0.55 : 0 }} />
		</AbsoluteFill>
	)
}

function MessagePill({ message, start, last, frame }: { message: Message; start: number; last: boolean; frame: number }) {
	const t = interpolate(frame, [start, start + TIMING.perMessage - 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
	if (frame < start) return null
	const from = X[message.from] - 32, to = X[message.to] - 32
	const reach = message.lost ? 0.55 : 1
	const x = from + (to - from) * Math.min(t, reach)
	const lostHit = message.lost && t >= reach
	const toServer = message.to === "server"
	return (
		<div style={{
			position: "absolute", top: 4, left: x, transform: `translateX(${interpolate(x, [X.client1 - 32, X.client2 - 32], [-12, -88])}%)`, whiteSpace: "nowrap",
			fontFamily: MONO, fontSize: 16, padding: "7px 12px", borderRadius: 999,
			background: lostHit ? C.del : toServer ? C.accentSoft : "#fff", color: lostHit ? C.delInk : C.ink,
			border: `1.5px solid ${lostHit ? C.delInk : toServer ? C.accent : "#9aa0ad"}`,
			opacity: last || message.lost ? 1 : interpolate(frame, [start + TIMING.perMessage, start + TIMING.perMessage + 6], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
			boxShadow: "0 2px 8px rgba(0,0,0,.08)",
		}}>
			{lostHit ? "✕ lost: " : toServer ? "→ " : "← "}{message.label}
		</div>
	)
}

function Card({ title, badge, children, dim, glow }: { title: string; badge?: ReactNode; children: ReactNode; dim?: boolean; glow?: string }) {
	return (
		<div style={{
			flex: 1, background: C.card, border: `1.5px solid ${glow === "bad" ? C.delInk : glow === "good" ? C.addInk : C.line}`, borderRadius: 14,
			padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0, opacity: dim ? 0.45 : 1, position: "relative",
		}}>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ fontSize: 22, fontWeight: 700 }}>{title}</span>
				{badge}
			</div>
			{children}
		</div>
	)
}

const Label = ({ children }: { children: ReactNode }) => (
	<div style={{ fontSize: 13, fontWeight: 700, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 4 }}>{children}</div>
)

function RecordRows({ records, prev }: { records: Records; prev?: Records }) {
	const keys = [...new Set([...Object.keys(records), ...Object.keys(prev ?? {})])].sort()
	if (keys.length === 0) return <div style={{ fontSize: 18, color: "#aaa", fontStyle: "italic" }}>no records</div>
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
			{keys.map((key) => {
				const has = key in records, had = prev ? key in prev : has
				const state = !prev ? "" : !has ? "gone" : !had ? "new" : records[key] !== prev[key] ? "chg" : ""
				const style: CSSProperties = {
					display: "flex", justifyContent: "space-between", gap: 10, fontFamily: MONO, fontSize: 18, padding: "5px 10px", borderRadius: 8,
					background: state === "new" ? C.add : state === "gone" ? C.del : state === "chg" ? C.chg : "#f4f4f0",
					color: state === "gone" ? C.delInk : C.ink, textDecoration: state === "gone" ? "line-through" : "none",
				}
				return (
					<div key={key} style={style}>
						<span style={{ fontWeight: 600 }}>{key}</span>
						<span>"{has ? records[key] : prev?.[key]}"</span>
					</div>
				)
			})}
		</div>
	)
}

function ClientCard({ name, view, prev, glow }: { name: ClientName; view: ClientView; prev?: ClientView; glow: string }) {
	const badge = (
		<span style={{ fontSize: 13, padding: "3px 9px", borderRadius: 999, background: !view.up ? C.del : view.subscribed ? C.accentSoft : "#eee", color: !view.up ? C.delInk : view.subscribed ? C.accent : C.muted, fontWeight: 600 }}>
			{!view.up ? "💥 crashed" : view.subscribed ? "subscribed" : "not subscribed"}
		</span>
	)
	return (
		<Card title={name} badge={badge} dim={!view.up} glow={glow}>
			<Label>What the app sees</Label>
			<RecordRows records={view.records} prev={prev?.records} />
			<Label>{view.pendingLabel}</Label>
			{view.pending.length === 0 ? <div style={{ fontSize: 17, color: "#aaa", fontStyle: "italic" }}>none</div> : view.pending.map((p, i) => (
				<div key={i} style={{ border: "1.5px dashed #9aa5c8", borderRadius: 8, padding: "5px 9px", fontFamily: MONO, fontSize: 15, lineHeight: 1.35 }}>
					{p.text}
					{p.detail ? <div style={{ color: C.muted }}>{p.detail}</div> : null}
				</div>
			))}
			{view.base ? (
				<>
					<Label>Base (last server state)</Label>
					<div style={{ fontFamily: MONO, fontSize: 15, color: C.muted }}>
						{Object.keys(view.base).length ? Object.entries(view.base).map(([k, v]) => `${k} "${v}"`).join(", ") : "empty"}
					</div>
				</>
			) : null}
		</Card>
	)
}

function ServerCard({ records, prev, facts }: { records: Records; prev?: Records; facts: string[] }) {
	return (
		<Card title="server">
			<Label>Records</Label>
			<RecordRows records={records} prev={prev} />
			<Label>Per-client sync state</Label>
			{facts.map((fact, i) => <div key={i} style={{ fontFamily: MONO, fontSize: 14.5, color: C.muted, lineHeight: 1.4 }}>{fact}</div>)}
		</Card>
	)
}

// ─── Verdict ──────────────────────────────────────────────────────────────
function VerdictCard({ verdict, closing, mode }: VideoProps) {
	const frame = useCurrentFrame()
	const { fps } = useVideoConfig()
	const s = spring({ frame, fps, config: { damping: 14 } })
	const color = verdict.pass ? C.addInk : C.delInk
	return (
		<AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 24, padding: 80 }}>
			<div style={{ width: 130, height: 130, borderRadius: "50%", background: verdict.pass ? C.add : C.del, color, fontSize: 78, fontWeight: 800, display: "grid", placeItems: "center", transform: `scale(${s})` }}>
				{verdict.pass ? "✓" : "✗"}
			</div>
			<div style={{ fontSize: 38, fontWeight: 700, color, textAlign: "center", opacity: fadeIn(frame, 6) }}>
				{verdict.pass ? "Converges" : mode === "failure" ? "Diverges from the server" : "Still diverges"}
			</div>
			<div style={{ fontSize: 26, textAlign: "center", maxWidth: 1000, opacity: fadeIn(frame, 12) }}>{verdict.text}</div>
			<div style={{ fontSize: 20, color: C.muted, textAlign: "center", maxWidth: 1000, opacity: fadeIn(frame, 24) }}>{closing}</div>
		</AbsoluteFill>
	)
}
