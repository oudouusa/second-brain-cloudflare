# Design decisions and rationale

## D1 is authoritative

Memory content and relationships are independent of Vectorize availability. CAS, before-images, deletion receipts, and write admission protect concurrent updates and recovery. Vectorize can be rebuilt from D1. R2 backups support memory recovery; normal writes are not dual-written to R2.

## Fixed embeddings

Retain the existing profile that reduces and normalizes EmbeddingGemma output to 128 dimensions. Do not mix models, dimensions, or vector generations within an index. Create the `parentId` and `workspace_id` metadata indexes before the first write to a new index. Migrating from a different profile requires a separate index and reindexing.

## Use upstream search

Retain the upstream tokenizer, FTS, reranker, Prompt Capsule, and project resolution. Keep adjustments for CJK text, full-width identifiers, and embedding failures at the consumer boundary, preserving scope and answer eligibility before LIMIT. Improvements on synthetic fixtures do not establish improvements in real-memory quality or billed rows.

## Optional generation provider

Workers AI is the default. Direct ChatGPT access is selected only after the owner authorizes use of their plan and explicitly selects operations and a personal workspace. Use encrypted credentials, a stable host belonging to the Worker, and refresh-race protection. Do not automatically send a failed selected operation to another provider. Persistence paths validate structured output and completion status.

## Dispatch to the existing DO

MCP, answers, REST search, administration probes, and nightly work run in the existing McpExecutor. Authenticate and enforce body limits at entry, and recheck scope and administrative permissions inside it. Hold response streams and write admission until completion. Dispatch is not a guarantee about free allowances or total CPU.

## Separate operations from public source

Keep real resource IDs, personal workspaces, and credentials out of the shared configuration. Explicitly select an ignored configuration for real deployments. Store deployment versions, D1 recovery points, backups, and measurements in owner-controlled storage. Public candidates retain upstream history and reviewed fork changes without bringing private branches, PRs, or Actions history with them.

## Preserve upstream dependency boundaries

Mechanically check alignment of the 21 upstream-owned files, dependency declarations, lockfile, and installer. Keep vulnerability findings visible. Assess usage conditions and reachability, and synchronize dependency changes with upstream fixes before validating them.
