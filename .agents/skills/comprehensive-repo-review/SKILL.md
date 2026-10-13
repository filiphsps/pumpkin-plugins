---
name: comprehensive-repo-review
description: Review an entire codebase for correctness, design, tests, documentation, performance, and maintainability, then coordinate fixes for verified findings. Use for full-repository reviews and review-and-remediation requests; supports custom focus areas and search patterns.
---

# Comprehensive Repo Review

Review the full requested repository scope, verify each finding, and carry verified findings through remediation.

## Request inputs

- Treat a supplied `Look for` list as the user's focus areas. Give those areas extra scrutiny while continuing to report other material issues found during the full review.
- Treat supplied `Search patterns` as candidate locators. Accept literal terms, paths or globs, regular expressions, and plain-language inspection queries. When none are supplied, use the default review prompts below as the search plan. The source prompt gives thematic prompts rather than literal expressions, so adapt them to the repository's languages and tools.
- Follow any explicit scope or exclusions from the user. Otherwise, review all repository-owned text files, including source, tests, documentation, configuration, scripts, workflows, and hidden project files.

## Default review prompts

Use these when the user gives no `Look for` list, and as the fallback search plan when no `Search patterns` are supplied:

- Code defects, logical bugs, incorrect assumptions, poor decisions, gaps, and improvement opportunities.
- Missing, outdated, incorrect, unclear, or AI-sounding documentation.
- Tests that assert exact output instead of behavior, weak coverage, and missing tests.
- Architectural problems, awkward boundaries, unnecessary complexity, and simplifications that preserve behavior.
- Missing, incorrect, outdated, or problematic JSDoc.
- Awkward, inconsistent, or misleading names.
- Runtime and workflow performance, including build and test speed.
- Reusable parts that should be extracted and repeated code or functionality that should be shared.
- Other evidence-backed problems of similar scope.

## Review coverage

1. Read the repository's `AGENTS.md` instructions and the relevant guides and skills they point to. Use `code-review-and-quality` as the review framework; add domain-specific skills when the code or docs call for them.
2. Inventory the repository before reviewing. Group files by package, subsystem, or concern, and keep a coverage ledger so every in-scope text file is read in full. Search tools locate candidates; they do not replace reading the files and surrounding context.
3. Trace important behavior across entry points, callers, shared helpers, tests, configuration, generated sources, and documentation. Check failure paths and assumptions as well as the happy path. Inspect test assertions for whether they protect observable behavior.
4. Use supplied search patterns in their stated form where supported. Inspect each match in context and follow references to its implementation, tests, and docs. Treat a match as a lead, not a finding by itself.
5. Include generated text output in the coverage ledger and inspect its owning source or generator when deciding how to fix an issue. Exclude only opaque binary assets and dependency caches, unless the user sets a different scope. List exact exclusions and any unreadable files; do not claim complete coverage while in-scope files remain unreviewed.

## Findings

Record each distinct, verified issue with:

- exact file and line or symbol;
- the evidence and affected behavior;
- the consequence;
- a concrete fix;
- severity and confidence.

Separate defects from optional improvements. Include small and large issues when evidence shows they matter; avoid subjective preferences without a user or project impact. If the issue is uncertain, assign a separate research agent to inspect the evidence and return a verdict before deciding whether to fix it.

## Remediation agents

For every verified finding, create a fresh, focused agent to implement that finding. Give each agent the evidence, affected paths, expected outcome, relevant constraints, and completion criteria. Ask each remediation agent to read and follow these local skills:

- [clean-code](../clean-code/SKILL.md)
- [test-driven-development](../test-driven-development/SKILL.md)
- [jsdoc-typescript-docs](../jsdoc-typescript-docs/SKILL.md)
- [typescript-advanced-types](../typescript-advanced-types/SKILL.md)
- [simple-man](../simple-man/SKILL.md)

Also use [code-review-and-quality](../code-review-and-quality/SKILL.md) and any applicable domain-specific skills. Keep each assignment to one finding. Serialize assignments that would edit overlapping code or depend on each other's result. If an investigation agent confirms an uncertain issue, use a separate remediation agent for the fix. If subagents are unavailable, do the same investigation and fix directly, and report that delegation was unavailable.

## Completion

After remediation, inspect every agent's changes against the finding and its acceptance criteria. Review affected callers, tests, and documentation, and run the repository's applicable checks. Track every finding as fixed, not confirmed, or unresolved, with a brief reason for anything left open. Report review coverage, exclusions, findings and dispositions, checks run, and exact failures or limitations. Do not describe the review as complete while any in-scope file, finding, or required verification remains unaccounted for.
