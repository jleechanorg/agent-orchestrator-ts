# novel/upstream — Composio Upstream Contributions

Content sourced from `ComposioHQ/agent-orchestrator` upstream, pulled from open PRs
during fork consolidation on 2026-03-25.

## Contents

| File / Dir | Source PR | Status |
|---|---|---|
| `the-awakening.md` | [ComposioHQ/agent-orchestrator#680](https://github.com/ComposioHQ/agent-orchestrator/pull/680) | Open upstream |
| `video/` | [ComposioHQ/agent-orchestrator#679](https://github.com/ComposioHQ/agent-orchestrator/pull/679) | Open upstream |

## the-awakening.md

The canonical serialized fiction from the Composio AO workers perspective, written by
`i-trytoohard` and collaborators. Placed here per our repo convention (not `docs/novel/`).

~8,500 words. Source: ComposioHQ PR #680 (still open upstream).

## video/ — Remotion Video Project

Self-contained Remotion 4 project that renders "The Awakening" as a ~90-second
cinematic text-reveal MP4, plus "ThePantheon" contributor title cards.

```bash
cd novel/upstream/video
npm install
npm start        # preview in browser
npm run build   # render out/the-awakening.mp4
bash render.sh  # supports: TheAwakening | ThePantheon | all
```

## Relationship to local novel

- `novel/the-daily-lives-of-workers.md` — **our** fork's serialized fiction (AO workers, jleechanorg perspective)
- `novel/upstream/the-awakening.md` — **upstream** Composio serialized fiction (Composio workers, Composio perspective)

Both are canonical; they complement each other and can be cross-referenced.
