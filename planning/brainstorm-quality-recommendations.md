# Brainstorm Quality: Next Iteration Recommendations

## Current State Summary

The brainstorm system has been stabilized across six subtasks: `reactiveInjection` now defaults to `false` (wave-bounded), steer handling is single-writer idempotent, per-deliverable synthesis contracts enforce structured output, and the `BrainstormOutcome` JSONB column plus analysis script provide end-to-end observability. The system is now measurable but has no outcome data yet (0/15 rooms have the `outcome` column populated — the column was added after those rooms ran). Additionally, 0/15 rooms have a `goal` set, and only 2/15 have a `deliverableType`, indicating the create flow does not nudge users toward filling these fields.

## Top Recommendation: Configuration Nudges in the Create Flow

### What to change

Add lightweight validation/nudges when creating a brainstorm room so that `goal` and `deliverableType` are effectively required. Specifically:

1. **Make `goal` a required field** in the create room UI (it can remain technically optional in the DB, but the form should block submission without it).
2. **Default `deliverableType` to `exploration`** instead of leaving it unset. The `exploration` contract has the lightest requirements (`Key Findings` + `Open Questions`) and is the safest fallback.
3. **Show a "completeness score"** (e.g., 2/4 fields filled) on the create form, highlighting `goal`, `deliverableType`, `constraints`, and `targetAudience`.

### Expected impact

- Synthesis quality improves immediately: the contract-driven prompts (`buildSynthesisPrompt`) produce dramatically better output when they know the deliverable type vs. falling back to generic prompts.
- The analysis script can segment outcomes by deliverable type and goal presence, enabling data-driven tuning of all other parameters.
- Low implementation cost: UI-only changes, no orchestrator or backend modifications needed.

### Evidence from code review

- `configCompleteness` in the analysis script shows 0% goal coverage, 13% deliverableType coverage across 15 rooms. These are the two fields that most heavily influence synthesis prompt quality.
- `buildSynthesisPrompt()` in `synthesis-decision-log.ts` branches on `deliverableType` to select the correct contract. When unset, it falls back to a generic prompt that lacks section structure.
- The playbook presets (`playbook.ts`) don't set `goal`, `deliverableType`, or `constraints` — they only configure wave mechanics. The presets are a missed opportunity to scaffold good configuration.

### How to measure success

After deploying, compare `configCompleteness.withGoal` and `configCompleteness.withDeliverableType` percentages in the analysis script output. Target: >80% of new rooms have both fields set. Then correlate with `synthesisParseSuccess` and `endState === 'converged'` rates in `byDeliverableType` breakdown.

## Runner-Up Candidates

### 2. Wave Broadcast Framing

`formatWaveBroadcast()` currently produces flat `[AgentName]:\nContent` blocks separated by `---`. Adding lightweight structure — a one-line position summary per agent (agree/disagree/new-angle) and a "topics under discussion" header — would help agents track the thread across waves and reduce repetition. Measure via `repeatRatio` trends in `WaveQualityScore`. Medium effort (prompt engineering + orchestrator change).

### 3. Reflection Trigger Tuning

`shouldTriggerReflection()` requires `repeatRatio > 0.5` AND declining `avgResponseLength` across two consecutive waves. The `agreementRatio` signal (already computed) is unused in the trigger logic. Adding `agreementRatio > 0.5` as an alternative trigger condition would catch "polite convergence" stalls where agents agree without adding substance but response length stays stable. Low effort, but needs outcome data to validate thresholds.

### 4. Multilingual Agreement Detection

`AGREEMENT_MARKERS` in `brainstorm-quality.ts` is English-only (15 phrases). For rooms with `config.language` set to a non-English value, `agreementRatio` will always read 0, making stall detection blind. Adding marker lists for the top 3-5 configured languages (or using a language-agnostic heuristic like response brevity + low `newIdeasCount`) would fix this. Low priority until non-English usage grows — currently 0/15 rooms set `language`.

## Explicit Non-Goals for Next Iteration

- **Changing convergence defaults** (`minWavesBeforePass: 2`, `convergenceMode: 'unanimous'`). No outcome data exists to justify changing these. Wait for at least 20 rooms with outcome data before tuning.
- **Validated synthesis mode** (`synthesisMode: 'validated'`). The single-pass synthesis pipeline was just stabilized with contracts. Adding a validation pass doubles synthesis cost and complexity. Defer until single-pass `synthesisParseSuccess` rate is measurably poor.
- **Role auto-assignment improvements**. The current 2/3/4-participant mappings in `role-templates.ts` are reasonable defaults. Roles are a secondary quality lever compared to getting `goal` and `deliverableType` populated.
- **Cross-room context** (`relatedRoomIds`). The related-synthesis injection in `buildPreamble()` already works. Improving it is polish, not a quality bottleneck.
