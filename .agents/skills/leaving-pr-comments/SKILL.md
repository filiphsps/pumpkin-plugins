---
name: leaving-pr-comments
description: Leave a PR comment on a user's behalf. Use when leaving a comment on a GitHub PR, issue, or commit.
---

When commenting on the user's behalf you must disclose that you're an AI model. To do that you should place add a disclosure header to the beginning of the comment:

```markdown
> [!NOTE]
> This commented was orchestrated by and posted on the behalf of {FIRST_NAME/@USERNAME} by {MODEL_NAME}.
```

This skill is not applicable when you're writing PR or issue bodies, in that case you should not include the disclosure.
