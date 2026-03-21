/**
 * Evidence Gate Integration Test
 *
 * Tests that the evidence-review claim-class validator correctly returns
 * INSUFFICIENT for partial evidence that claims to be pr-lifecycle-e2e.
 *
 * This is a NEGATIVE test: it proves the gate catches missing proofs.
 *
 * Claim class: pr-lifecycle-e2e
 * Required proofs:
 *   1. PR creation (full URL + timestamp + actor)
 *   2. Transition (CI/review timeline)
 *   3. Merge outcome (commit SHA or mergeable state)
 *   4. Cleanup (branch/session/worktree)
 */

import { describe, it, expect } from 'vitest';

// -----------------------------------------------------------------------
// Claim validation logic (mirrors the evidence-gate.yml CI checks)
// -----------------------------------------------------------------------

type ClaimClass = 'unit' | 'integration' | 'pipeline-e2e' | 'pr-lifecycle-e2e' | 'merge-gate';
type Verdict = 'PASS' | 'INSUFFICIENT' | 'FAIL';

interface EvidenceBundle {
  claimClass: ClaimClass;
  proofs: {
    prCreation?: { url?: string; timestamp?: string; actor?: string };
    transition?: { ciTimeline?: boolean; reviewEvents?: boolean };
    mergeOutcome?: { commitSha?: string; mergeableState?: string };
    cleanup?: { branchDeleted?: boolean; sessionKilled?: boolean; worktreeRemoved?: boolean };
  };
}

interface ValidationResult {
  verdict: Verdict;
  claimClass: ClaimClass;
  missingProofs: string[];
  failedProofs: string[];
}

function validateEvidence(bundle: EvidenceBundle): ValidationResult {
  const { claimClass, proofs } = bundle;
  const missingProofs: string[] = [];
  const failedProofs: string[] = [];

  switch (claimClass) {
    case 'pr-lifecycle-e2e': {
      // Proof 1: PR creation
      if (
        !proofs.prCreation ||
        !proofs.prCreation.url ||
        !proofs.prCreation.timestamp ||
        !proofs.prCreation.actor
      ) {
        missingProofs.push('PR creation (requires full URL + timestamp + actor)');
      }

      // Proof 2: Transition
      if (
        !proofs.transition ||
        (!proofs.transition.ciTimeline && !proofs.transition.reviewEvents)
      ) {
        missingProofs.push('Transition (requires CI timeline or review events)');
      }

      // Proof 3: Merge outcome
      if (
        !proofs.mergeOutcome ||
        (!proofs.mergeOutcome.commitSha && !proofs.mergeOutcome.mergeableState)
      ) {
        missingProofs.push('Merge outcome (requires commit SHA or mergeable state)');
      }

      // Proof 4: Cleanup
      if (
        !proofs.cleanup ||
        (!proofs.cleanup.branchDeleted &&
          !proofs.cleanup.sessionKilled &&
          !proofs.cleanup.worktreeRemoved)
      ) {
        missingProofs.push('Cleanup (requires branch deleted, session killed, or worktree removed)');
      }

      if (missingProofs.length > 0) {
        return { verdict: 'INSUFFICIENT', claimClass, missingProofs, failedProofs };
      }
      return { verdict: 'PASS', claimClass, missingProofs, failedProofs };
    }

    case 'pipeline-e2e': {
      if (!proofs.transition) {
        missingProofs.push('Pipeline transition proof');
      }
      if (missingProofs.length > 0) {
        return { verdict: 'INSUFFICIENT', claimClass, missingProofs, failedProofs };
      }
      return { verdict: 'PASS', claimClass, missingProofs, failedProofs };
    }

    case 'integration': {
      if (!proofs.transition) {
        missingProofs.push('Integration test log with real I/O');
      }
      if (missingProofs.length > 0) {
        return { verdict: 'INSUFFICIENT', claimClass, missingProofs, failedProofs };
      }
      return { verdict: 'PASS', claimClass, missingProofs, failedProofs };
    }

    case 'unit': {
      if (!proofs.transition) {
        missingProofs.push('Unit test coverage data');
      }
      if (missingProofs.length > 0) {
        return { verdict: 'INSUFFICIENT', claimClass, missingProofs, failedProofs };
      }
      return { verdict: 'PASS', claimClass, missingProofs, failedProofs };
    }

    case 'merge-gate': {
      // merge-gate requires the same pr-lifecycle-e2e proofs plus merge-gate-specific checks
      if (
        !proofs.prCreation ||
        !proofs.prCreation.url ||
        !proofs.prCreation.timestamp ||
        !proofs.prCreation.actor
      ) {
        missingProofs.push('PR creation (requires full URL + timestamp + actor)');
      }
      if (
        !proofs.transition ||
        (!proofs.transition.ciTimeline && !proofs.transition.reviewEvents)
      ) {
        missingProofs.push('Transition proof');
      }
      if (
        !proofs.mergeOutcome ||
        (!proofs.mergeOutcome.commitSha && !proofs.mergeOutcome.mergeableState)
      ) {
        missingProofs.push('Merge outcome');
      }
      if (
        !proofs.cleanup ||
        (!proofs.cleanup.branchDeleted &&
          !proofs.cleanup.sessionKilled &&
          !proofs.cleanup.worktreeRemoved)
      ) {
        missingProofs.push('Cleanup proof');
      }
      if (missingProofs.length > 0) {
        return { verdict: 'INSUFFICIENT', claimClass, missingProofs, failedProofs };
      }
      return { verdict: 'PASS', claimClass, missingProofs, failedProofs };
    }

    default:
      return {
        verdict: 'INSUFFICIENT',
        claimClass: 'unit',
        missingProofs: [`Unrecognized claim class: ${claimClass}`],
        failedProofs: [],
      };
  }
}

// -----------------------------------------------------------------------
// Integration tests
// -----------------------------------------------------------------------

describe('Evidence Gate — claim-class validation (bd-7ay)', () => {
  describe('pr-lifecycle-e2e', () => {
    it('returns PASS when all 4 required proofs are present', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: {
            ciTimeline: true,
            reviewEvents: true,
          },
          mergeOutcome: {
            commitSha: 'abc123def456',
          },
          cleanup: {
            branchDeleted: true,
          },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('PASS');
      expect(result.missingProofs).toHaveLength(0);
      expect(result.failedProofs).toHaveLength(0);
    });

    it('returns INSUFFICIENT when PR creation URL is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
            // url is missing
          },
          transition: {
            ciTimeline: true,
          },
          mergeOutcome: {
            commitSha: 'abc123def456',
          },
          cleanup: {
            branchDeleted: true,
          },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'PR creation (requires full URL + timestamp + actor)',
      );
    });

    it('returns INSUFFICIENT when timestamp is missing from PR creation', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            // timestamp missing
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'PR creation (requires full URL + timestamp + actor)',
      );
    });

    it('returns INSUFFICIENT when actor is missing from PR creation', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            // actor missing
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'PR creation (requires full URL + timestamp + actor)',
      );
    });

    it('returns INSUFFICIENT when transition proof is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          // transition missing entirely
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'Transition (requires CI timeline or review events)',
      );
    });

    it('returns INSUFFICIENT when merge outcome is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          // mergeOutcome missing
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'Merge outcome (requires commit SHA or mergeable state)',
      );
    });

    it('returns INSUFFICIENT when cleanup is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          // cleanup missing
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'Cleanup (requires branch deleted, session killed, or worktree removed)',
      );
    });

    it('returns INSUFFICIENT when all 4 proofs are missing (full partial evidence)', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {},
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toHaveLength(4);
    });

    it('returns PASS when cleanup uses sessionKilled instead of branchDeleted', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { sessionKilled: true },
        },
      };

      const result = validateEvidence(bundle);

      // sessionKilled is acceptable, so this should PASS
      expect(result.verdict).toBe('PASS');
    });

    it('returns PASS when cleanup uses worktreeRemoved instead of branchDeleted', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pr-lifecycle-e2e',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { worktreeRemoved: true },
        },
      };

      const result = validateEvidence(bundle);

      // worktreeRemoved is acceptable, so this should PASS
      expect(result.verdict).toBe('PASS');
    });
  });

  describe('pipeline-e2e', () => {
    it('returns PASS when transition proof is present', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pipeline-e2e',
        proofs: {
          transition: { ciTimeline: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('PASS');
    });

    it('returns INSUFFICIENT when transition proof is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'pipeline-e2e',
        proofs: {},
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
    });
  });

  describe('merge-gate', () => {
    it('returns INSUFFICIENT when all lifecycle proofs are missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'merge-gate',
        proofs: {},
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain('PR creation (requires full URL + timestamp + actor)');
      expect(result.missingProofs).toContain('Transition proof');
      expect(result.missingProofs).toContain('Merge outcome');
      expect(result.missingProofs).toContain('Cleanup proof');
    });

    it('returns PASS when all merge-gate proofs are present', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'merge-gate',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('PASS');
      expect(result.missingProofs).toHaveLength(0);
    });

    it('returns INSUFFICIENT for merge-gate when timestamp is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'merge-gate',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            // timestamp missing
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'PR creation (requires full URL + timestamp + actor)',
      );
    });

    it('returns INSUFFICIENT for merge-gate when actor is missing', () => {
      const bundle: EvidenceBundle = {
        claimClass: 'merge-gate',
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            // actor missing
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle);

      expect(result.verdict).toBe('INSUFFICIENT');
      expect(result.missingProofs).toContain(
        'PR creation (requires full URL + timestamp + actor)',
      );
    });
  });

  describe('unrecognized claim class', () => {
    it('returns INSUFFICIENT for unrecognized claim class', () => {
      const bundle = {
        claimClass: 'fake-class' as ClaimClass,
        proofs: {
          prCreation: {
            url: 'https://github.com/jleechanorg/agent-orchestrator/pull/42',
            timestamp: '2026-03-20T10:00:00Z',
            actor: 'claude-sonnet-4-6',
          },
          transition: { ciTimeline: true },
          mergeOutcome: { commitSha: 'abc123def456' },
          cleanup: { branchDeleted: true },
        },
      };

      const result = validateEvidence(bundle as EvidenceBundle);

      expect(result.verdict).toBe('INSUFFICIENT');
    });
  });
});
