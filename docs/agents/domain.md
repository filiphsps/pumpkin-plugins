---
title: "Agent domain docs"
description: "How agents use glossaries and ADRs to keep terms and decisions aligned"
---

# Domain docs for agents

Use the glossary to keep domain language consistent, and check relevant ADRs before proposing or changing an architectural decision.

This repository is an ecosystem umbrella with multiple domain contexts, not a single product domain.
Read [GLOSSARY-MAP.md](../../GLOSSARY-MAP.md) for their boundaries and relationships. The root
[`GLOSSARY.md`](../../GLOSSARY.md) covers only the Pumpkin Plugin API; add a glossary for another
context only when shared project vocabulary warrants one.

## Before you explore

1. Check the repository root for `GLOSSARY-MAP.md`. If it exists, read it and then read the glossary files for the contexts relevant to your work. Otherwise, read the root `GLOSSARY.md` if it exists.
2. Read the ADRs in `docs/adr/` that cover the area you're working on. For a context-specific decision, check for ADRs near that context's code or docs; repository contexts don't all follow a `src/<context>/` layout.

Missing files don't block the work. Continue without calling out their absence or proposing their creation before there's a term or decision to record. The `/domain-modeling` skill, called by `/grill-with-docs` and `/improve-codebase-architecture`, creates a glossary when a term needs recording and offers an ADR only for a choice that's hard to reverse, surprising without context, and came from a real tradeoff.

## Common layouts

In a single-context repository, the glossary and ADRs usually sit at the root:

```text
/
├── GLOSSARY.md
├── docs/
│   └── adr/
└── src/
```

A root `GLOSSARY-MAP.md` signals a multi-context repository. It points to each context's glossary; ADRs can be system-wide or scoped to one context:

```text
/
├── GLOSSARY-MAP.md
├── docs/adr/              # system-wide decisions
└── src/
    └── <context>/
        ├── GLOSSARY.md
        └── docs/adr/      # context-specific decisions
```

## Use the glossary's terms

When you name a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the glossary's preferred term. Avoid synonyms it explicitly rules out.

If you need a concept the glossary doesn't define, check whether you're inventing a term the project doesn't use or documenting a genuine gap. Reconsider the invented term; note a real gap for the domain-modeling skill.

## Surface meaningful ADR conflicts

If a proposed change conflicts with an ADR strongly enough to warrant revisiting it, name the ADR and explain why. Don't list theoretical alternatives that don't create real friction.
