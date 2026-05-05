---
name: technique-router
description: Classifies GitHub issues/PRs into PR-type categories and recommends autor techniques. Used by packages/core/src/decomposer.ts.
---

# technique-router — ZFC-Compliant PR Type Classification Skill

## Purpose

Classifies a GitHub issue/PR description into a PR-type category, then recommends the appropriate autor technique. This is **classification-only until routing is wired**: `classifyPrType()` returns PR-type metadata, but technique resolution still happens separately through prompt/config defaults. All classification is delegated to the model API — no heuristic scoring, keyword matching, or hardcoded routing tables.

## PR Types

| Type | Description |
|------|-------------|
| `state-bool` | Widening boolean semantics (int 1/0, string '1'/'0' as valid True/False) |
| `data-norm` | Normalizing key names and numeric formats (xp→xp_gained, NaN handling) |
| `ci-workflow` | GitHub Actions workflow changes (YAML scripting, gate logic) |
| `typeddict-schema` | TypedDict + validation for previously untyped data structures |
| `large-arch-refactor` | Module extraction, moving functions between files |
| `unknown` | Cannot determine from the description |

## Technique Selection (Autor Research — Phase 10)

All 9 autor techniques converge within rubric noise (~80-85 confidence-interval overlap). **SR-prtype is the safe default** for all PR types. No per-type routing is statistically justified.

| Technique | Description | When to use |
|-----------|-------------|-------------|
| `SR-prtype` | Self-Refine with PR-type classification | **Safe default for all types** |
| `SR-fewshot` | Self-Refine with single prior PR exemplar | When a highly similar prior PR exists |
| `SR` | Basic 3-round self-refine | Fallback |
| `ET` | Extended chain-of-thought reasoning | Complex architectural decisions |
| `PRM` | Process Reward Model (score each step) | Debugging, multi-step reasoning |

## Usage

```bash
/technique-router <issue-title> <issue-body-or-url>
```

## ZFC Compliance

This skill does NOT:
- Match keywords like "fix", "bug", "refactor" to determine type
- Use regex or substring checks for intent detection
- Apply hardcoded scoring weights
- Use if/else chains that guess intent from text

This skill DOES:
- Pass the issue text to the model with a clear classification prompt
- Return the model's classification as the decision
- Let the caller decide what to do based on the classification

## Integration

Used by `packages/core/src/decomposer.ts`'s `classifyPrType()` function in the AO core library. That function classifies PR type only; it does not yet select or apply a technique directly.
