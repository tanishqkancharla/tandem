---
name: add-code-review-data
description: Import a code change and an explanation of that change into the cashew-labs/code-review-data dataset as one self-contained case. Use this when the user has just had a review, walkthrough, or explanation authored and wants it captured, when they say "add this to code-review-data" or "capture this task", or when they want an existing case's curation records updated. Do not use it for ordinary code review.
---

# Adding a case to code-review-data

The dataset collects **code changes plus explanations of those changes**. One import produces one self-contained case directory.

`cashew-labs/code-review-data` is private and its `AGENTS.md` is the authority. **Read that file in full before writing anything** — this skill is a shortcut through it, not a replacement:

```sh
gh api repos/cashew-labs/code-review-data/contents/AGENTS.md --jq '.content' | base64 -d
```

Read `docs/format.md` for exact manifest and document fields. Do not copy field lists out of this skill; copy them from there.

## When to call this

Call it when a review or explanation already exists and the user wants it preserved as training data. The task does not need to be merged, pushed, or approved first.

Do not call it to write a review in the first place — that is the `review` skill.

## Locate the dataset

The path on the original workstation is `~/Desktop/Saffron-Repos/code-review-data`. If it is not there, ask the user for the path before doing anything. If they do not have a checkout, offer to clone it with `gh repo clone cashew-labs/code-review-data`, and confirm first — it is private.

Treat the path the user gives you as `$DATASET_ROOT` for the whole import.

## 1. Identify the task and destination

Check `git status` in both repos first. Preserve unrelated edits. **Never switch, reset, clean, stage, commit, or push the source project's real branch just to capture data.**

Pick a stable kebab-case id like `tandem-dst-scheduler`. Add `cases/<id>/`. If the case exists, update its curation records in place rather than making a duplicate.

Base is the requested before-state, head is the exact after-state being explained. Resolve both to full SHAs — never store a moving branch name as identity.

Capture only this task's conversation. Stop before unrelated work or dataset curation, and record partial coverage honestly.

## 2. Snapshot the code without touching the user's repo

Create `repo/base.bundle`, `repo/change.bundle`, `repo/provenance.json`, and `changes/full.patch`. One full patch only, not separate implementation and test patches. Do not assign a new license to imported code.

For uncommitted work, build a snapshot commit through a **temporary index** so the real index and branch stay untouched:

```sh
CASE_ID="tandem-dst-scheduler"
CASE_DIR="$DATASET_ROOT/cases/$CASE_ID"
mkdir -p "$CASE_DIR/repo" "$CASE_DIR/changes" "$DATASET_ROOT/tmp/$CASE_ID"

SNAPSHOT_INDEX="$DATASET_ROOT/tmp/$CASE_ID/snapshot.index"
GIT_INDEX_FILE="$SNAPSHOT_INDEX" git -C "$SOURCE_ROOT" read-tree "$SOURCE_HEAD"
GIT_INDEX_FILE="$SNAPSHOT_INDEX" git -C "$SOURCE_ROOT" add -- path/to/changed-file
SNAPSHOT_TREE=$(GIT_INDEX_FILE="$SNAPSHOT_INDEX" git -C "$SOURCE_ROOT" write-tree)
HEAD_SHA=$(printf 'Dataset snapshot: %s\n' "$CASE_ID" | git -C "$SOURCE_ROOT" commit-tree "$SNAPSHOT_TREE" -p "$SOURCE_HEAD")
```

Pick a fresh index filename if one already exists. List the changed files explicitly — never `add -A`. Check the resulting diff before archiving; exclude secrets, dependencies, and unrelated work.

A snapshot is **not** proof of correctness or approval. Do not invent a commit to make an empty comparison look substantive.

Bundles need named refs, created and deleted with an expected-value check:

```sh
BASE_REF="refs/dataset-export/$CASE_ID/base"
HEAD_REF="refs/dataset-export/$CASE_ID/head"
git -C "$SOURCE_ROOT" update-ref "$BASE_REF" "$BASE_SHA" ''
git -C "$SOURCE_ROOT" update-ref "$HEAD_REF" "$HEAD_SHA" ''
git -C "$SOURCE_ROOT" bundle create "$CASE_DIR/repo/base.bundle" "$BASE_REF"
git -C "$SOURCE_ROOT" bundle create "$CASE_DIR/repo/change.bundle" "$HEAD_REF" "^$BASE_SHA"
git -C "$SOURCE_ROOT" diff --binary --no-renames "$BASE_SHA" "$HEAD_SHA" > "$CASE_DIR/changes/full.patch"
git -C "$SOURCE_ROOT" update-ref -d "$BASE_REF" "$BASE_SHA"
git -C "$SOURCE_ROOT" update-ref -d "$HEAD_REF" "$HEAD_SHA"
```

Record those exact ref names in `base_bundle_ref` and `head_bundle_ref`. Note origin URL with credentials stripped, full SHAs, head tree, snapshot-vs-committed status, license, and portability limits in `repo/provenance.json`. Git LFS and submodules are not carried by a bundle — archive the assets or record what is unavailable.

## 3. Import the context

The target shape is `context/timeline.jsonl` plus `artifacts/` and `provenance.json`. Keep only observable messages, tool calls, and results, in recorded order. No private reasoning, no system instructions, no credentials, no unrelated history. Mark truncation and gaps explicitly rather than filling them in.

`scripts/import_context.py` handles **Codex rollout JSONL only**, needs an **explicit inclusive line range**, and **refuses an existing timeline**. Inspect the record boundaries first, without printing secrets, then write a config under `tmp/`:

```json
{
  "session_id": "actual-source-session-id",
  "start_line": 10,
  "end_line": 450,
  "scope": "This task only, through implementation and review authoring",
  "phase_boundaries": [
    {"source_line": 10, "phase": "diagnosis"},
    {"source_line": 80, "phase": "implementation"},
    {"source_line": 400, "phase": "review_authoring"}
  ],
  "path_replacements": {"/absolute/source/path": "<SOURCE_REPO>"},
  "attachments": []
}
```

```sh
python3 "$DATASET_ROOT/scripts/import_context.py" \
  --source /path/to/task-rollout.jsonl \
  --case "$CASE_DIR" \
  --config "$DATASET_ROOT/tmp/$CASE_ID/context-import.json"
```

To update an existing case, import into a temporary case directory and compare before overwriting.

The importer redacts tokens and paths, but it is not a privacy audit. Read the exported artifacts. Never run captured commands to recreate results the transcript did not record.

## 4. Write the task, candidates, and answer

- `task.md` — a standalone explanation-writing request. The model already gets the code, so it is not a repair task.
- `environment.json` — this project's real requirements. Do not copy another case's versions.
- `candidates/<tool-or-run>/` — only explanation documents that were actually generated. Metadata describing a diff-only session is valid. Never invent a candidate for a tool that was not used, and never overwrite an original candidate while revising the answer.
- `feedback/events.jsonl` — exact user comments with stable IDs, scope, and a separate interpretation field. Empty is valid. Never turn narrow feedback into a whole-document ranking.
- `ideal-review/review.md` plus matching `review.json` — **one cumulative answer, edited in place.** Never create `review-2.md` for new feedback; Git holds the history. `revision` is a content id, not a filename: bump it in both the manifest and the document whenever the answer changes.

**Start every new answer as `status: "draft"` with `human_approved: false` and null approval identity and time.** It is never golden just because you like it or tests pass. If an approved answer changes, reset it to draft and clear the approval until the user approves the new revision.

Approval requires the user's explicit approval of that exact revision, recorded as a `reference_approval` feedback event with `actor: "user"` and the `revision`.

## 5. Register and verify

Write `case.json` per `docs/format.md` schema 0.2, with paths relative to the case directory. Start `split: "curation"`, `status: "collecting_feedback"`, a stable `group_id`, and add the manifest path to `dataset.json.cases` once.

`inputs.user_request_phases` covers diagnosis and implementation. Exclude review-authoring and dataset-feedback phases. Omit `inputs.historical_evidence` rather than fabricating a results summary.

```sh
cd "$DATASET_ROOT"
python3 scripts/dataset.py refresh
python3 scripts/dataset.py validate
python3 scripts/dataset.py materialize <case-id> --side base --output tmp/<case-id>/base
python3 scripts/dataset.py materialize <case-id> --side head --output tmp/<case-id>/head
python3 scripts/dataset.py export-requests  > tmp/requests.jsonl
python3 scripts/dataset.py export-prompts   > tmp/prompts.jsonl
python3 scripts/dataset.py export-sft       > tmp/approved-sft.jsonl
```

`refresh` seals artifact hashes; it does **not** approve anything. `validate` checks hashes, timeline links, gaps, patch reproduction, and offline restoration — it does not rerun the source project's tests.

Then read the exports. Prompts must contain no ideal review, no completed candidate, no post-review feedback, and no assistant conversation. A draft case must never appear as an approved SFT target.

Keep original test results as historical observations. Do not run an archived app's tests to import a completed case unless the user asks.

## 6. Hand off

Report the case id and path, the base and head SHAs, how complete the capture is, the validation result, and whether the answer is draft or explicitly approved.

A local commit is fine once the import checks out. **Do not push or publish without an explicit request.** Keep scratch work in gitignored `tmp/`, and leave unrelated changes alone.
