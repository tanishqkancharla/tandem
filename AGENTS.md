# Agent Instructions

Tandem is unreleased. Do not preserve migrations, compatibility fallbacks, or legacy code paths unless the user explicitly asks for them. Prefer cutting and editing relentlessly before release: keep the design small, remove obsolete behavior, and avoid compatibility layers that only serve pre-release states.

Tests should protect user-facing behavior and developer experience, not internal data formats. Prefer type-level tests for TypeScript inference APIs, public API boundary tests for runtime behavior, and fail-fast tests only for errors developers can actually encounter. Avoid snapshotting or asserting exact internal normalized/encoded structures unless that structure is a documented public contract.
