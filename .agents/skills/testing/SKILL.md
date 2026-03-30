---
name: testing
description: |
  Design and implement automated tests around concrete user-facing flows with the minimum suite needed to trust the behavior. Use when adding, pruning, or restructuring tests.
---

# Testing

Write tests as user stories, not as a checklist of methods or branches.

## Core principles

- Each test should cover one concrete flow that a user of the API, feature, or component would actually experience.
- The suite as a whole should contain the minimum set of tests needed to believe the feature works.
- Prefer a small number of story-shaped tests over many narrow implementation-shaped tests.
- Avoid `test.each` unless each row represents a meaningfully different user story.
- Do not create separate tests for tiny variations that can be covered in one clear flow.

## Required exercise before writing tests

1. List the public behaviors or user stories the code must support.
2. Collapse overlapping stories until only the essential ones remain.
3. For each remaining story, write:
   - why it matters
   - the minimal assertions needed to prove it
4. Identify which existing tests are redundant, too granular, or implementation-specific.
5. Only then write or edit the tests.

## What to keep

Keep tests that prove:
- the main happy path
- important negative/recovery behavior
- distinct escape hatches or user-visible modes
- explicit guardrails or unsupported cases that must fail clearly

## What to remove or merge

Remove or merge tests that:
- only verify internal steps with no distinct user-facing value
- split one flow across multiple tiny tests
- repeat the same story with different fields or permutations
- exist only because an API has multiple methods with similar mechanics

## Test-writing guidance

When drafting a test:
- Name it like a user story.
- Prefer one realistic flow with a beginning, decision point, and outcome.
- Assert only what is necessary to prove the story.
- If several assertions belong to the same flow, keep them in the same test.

## Suggested workflow

1. Read the feature code and current tests.
2. Write a short list of proposed user stories.
3. Propose the minimal final suite.
4. Get rid of redundant tests.
5. Implement the remaining tests.
6. Run the relevant test/typecheck/lint commands.

## Output format

Before changing tests, explicitly list:

### User stories
- ...

### Minimal test suite
- Keep: ...
- Merge: ...
- Drop: ...

Then implement the suite that matches that plan.
