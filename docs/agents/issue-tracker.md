---
title: "Issue tracker"
description: "GitHub issue commands and repository conventions"
---

# Issue tracker: GitHub

We track issues and specs as GitHub issues. Run the `gh` commands below from this clone; GitHub CLI
infers the repository from `git remote -v`.

## Create and update issues

Use a public issue form from `.github/ISSUE_TEMPLATE/` when filing a report. Report security
vulnerabilities through the private reporting link in the issue chooser, never in a public issue.

Before an issue enters triage, its form's required sections must be present and complete. If an issue
doesn't match a form or is missing required sections, the Issue intake workflow removes
`status: needs triage` and applies `status: needs info`. Edit the issue to add the missing headings
and details. When a tracked issue is complete, the workflow removes `status: needs info` and restores
`status: needs triage`. Upstream pin issues are exempt. The optional affected-component field does
not add `area:*` labels; maintainers choose those during triage.

- **Create an issue:** `gh issue create --title "..." --body "..."`. For a multi-line body, use a
  heredoc and include the required headings from the matching form so the workflow can validate it.
- **Read an issue:** `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`. Add the appropriate `--label` and `--state` filters.
- **Comment:** `gh issue comment <number> --body "..."`.
- **Add or remove labels:** `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- **Close an issue with a comment:** `gh issue close <number> --comment "..."`.

To make one issue a child of another, use `gh issue create --parent <parent> ...` or run
`gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). On an older `gh`, use
`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`;
`<child-db-id>` is the child's database id. If GitHub sub-issues aren't available, put
`Part of #<parent>` at the top of the child issue body.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set this to `yes` if the repo treats external PRs as feature
requests; `/triage` reads this flag.)_

When this flag is `yes`, triage PRs with the `gh pr` equivalents:

- **Read a PR:** `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage:** `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment, label, or close:** `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, or `gh pr close`.

GitHub uses one number space for issues and PRs, so `#42` alone is ambiguous. Check with
`gh pr view 42`; if it isn't a PR, use `gh issue view 42`.

## Instructions referenced by other skills

- When a skill says **publish to the issue tracker**, create a GitHub issue.
- When a skill says **fetch the relevant ticket**, read it with
  `gh issue view <number> --json number,title,body,labels,comments`.

## Wayfinding operations

`/wayfinder` stores one map issue and its decision tickets in GitHub. Use the map's
`wayfinder:map` label; link each ticket as a GitHub sub-issue. If sub-issues aren't enabled, add
each child to a task list in the map body and put `Part of #<map>` at the top of the child body.
Label each ticket `wayfinder:<type>` with one of `research`, `prototype`, `grilling`, or `task`.
Once claimed, assign it to the developer driving the map.

The issue intake workflow currently recognizes only the public issue forms and exempts upstream-pin
issues. It treats a new Wayfinder map or ticket without a matching form as an unmatched issue, removes
`status: needs triage`, and adds `status: needs info`. The Wayfinder conventions do not provide an
intake exemption, so expect this label behavior until the workflow supports these tickets.

### Track blockers and find the next ticket

Use GitHub's native issue dependencies when available; they appear in GitHub's UI. Add a blocking
edge with:

```sh
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>
```

`<blocker-db-id>` must be the blocker's numeric database id, not its issue number or `node_id`. Get
it with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. GitHub reports the count of open
blockers in `issue_dependencies_summary.blocked_by`. If native dependencies aren't available,
write `Blocked by: #<n>, #<n>` at the top of the child body instead. A ticket is unblocked when all
its blockers are closed.

To find the frontier, list the map's open child issues with `gh issue list --state open`, scoped to
the map's sub-issues or task list. Skip tickets with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in a `Blocked by` line) and tickets that already have an assignee. The first remaining ticket in map order is next.

Claim it with `gh issue edit <n> --add-assignee @me` before doing any work; this assignment must be
the session's first write.

### Resolve a ticket

Post the answer as a comment with `gh issue comment <n> --body "<answer>"`, close the ticket with
`gh issue close <n>`, then append a context pointer (gist and link) to the map's `Decisions so far`
section.
