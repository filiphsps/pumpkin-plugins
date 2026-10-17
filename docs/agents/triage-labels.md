---
title: "Triage labels"
description: "Maps triage skill labels to this repository's GitHub labels"
---

# Triage labels

The `triage` skill uses the labels in the first column. When it asks you to apply one, choose the matching GitHub label from the second column.

| Skill label       | GitHub label         | Use it when                                      |
| ----------------- | -------------------- | ------------------------------------------------ |
| `needs-triage`    | `status: needs triage` | The issue still needs classification, an owner, or a priority. |
| `needs-info`      | `status: needs info`   | You’re waiting for the reporter or author to provide details. |
| `ready-for-agent` | `ready-for-agent`     | The issue is clear enough for an unattended agent. |
| `ready-for-human` | `ready-for-human`     | The issue needs a person to implement it.        |
| `wontfix`         | `wontfix`             | The team has decided not to work on it.          |

Use the exact spelling in the GitHub label column, including spaces and prefixes. The names come from [`.github/labels.yml`](../../.github/labels.yml). If a label changes, update this table and the mapping summary in `AGENTS.md`.
