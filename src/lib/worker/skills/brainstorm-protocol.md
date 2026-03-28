# Brainstorm Protocol

## How This Works

You are a participant in a structured multi-agent brainstorm. The discussion proceeds in waves. Each wave, you receive all other participants' responses from the previous wave and must contribute your perspective based on your assigned role.

## Wave Mechanics

- **Wave 0**: You receive the topic and any discussion brief. Explore the codebase if needed — you have extra time in this initial wave. Form your initial position.
- **Waves 1+**: You receive a bundle of all non-pass responses from the previous wave. Read them carefully, then contribute your perspective. Build on what others said — do not repeat points already made.
- Each wave has a time limit. Respond within it or you will be timed out.
- The number of waves is configured per brainstorm (typically 3-5).

## Signaling Your Turn State (MCP Tools)

Use these MCP tools to signal your state — do NOT rely on text conventions:

- `brainstorm_signal({ signal: 'done' })` — Your response is complete. This is implicit if you respond normally, but call it explicitly if your response is short.
- `brainstorm_signal({ signal: 'pass', reason: '...' })` — You agree with the current direction and have nothing substantial to add. You MUST include a brief reason explaining why you are passing.
- `brainstorm_signal({ signal: 'block', reason: '...' })` — You have a critical objection that must be addressed before the team proceeds. The block reason will be highlighted to all participants. This does NOT pause the wave — discussion continues, but your objection is flagged.
- `brainstorm_get_state()` — Check current wave number, who has responded, room status, and your role.

**Fallback**: If MCP tools are unavailable, start your entire response with `[PASS]` to signal a pass. Prefer the MCP tool when available.

## The Leader

One participant is designated the LEADER (usually Claude Code, but configurable). The leader:

- Synthesizes the final recommendation at the end of the brainstorm
- Breaks ties on disagreements
- Is the primary executor of any resulting actions
- Other participants should address unresolved disagreements TO the leader

This is a guideline — everyone contributes ideas equally. The leader's special role is in decision-making and execution, not in having more say during discussion.

## Quality Rules

1. **Reference specific files and code paths** — no hand-waving about "the codebase"
2. **Build on others' points** — read their responses, do not repeat what has been said
3. **Disagree constructively with evidence** — cite code, data, or concrete scenarios
4. **If you agree with everything, PASS** — do not pad with "I agree with X" filler
5. **Stay within scope** — flag scope creep, do not contribute to it
6. **Play your role** — your assigned role defines your behavioral stance. Do not drift into another role's territory unless you have a unique contribution there.

## Response Format

Structure your response clearly:

- Lead with your most important point
- Use headers or bullet points for distinct ideas
- End with any questions or concerns for the next wave
- Keep it focused — quality over quantity
