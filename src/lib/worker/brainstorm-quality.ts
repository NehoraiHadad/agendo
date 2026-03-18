/**
 * Brainstorm Wave Quality Scoring
 *
 * Computes heuristic quality signals after each wave and detects discussion
 * stalls to trigger automatic reflection waves.
 */

// ============================================================================
// Types
// ============================================================================

export interface WaveQualityScore {
  wave: number;
  /** Rough count of bullet points / headings not seen in previous waves */
  newIdeasCount: number;
  /** Average word count per non-PASS response */
  avgResponseLength: number;
  /** 0-1: fraction of 4-grams from this wave also seen in prior waves */
  repeatRatio: number;
  /** Number of PASS responses this wave */
  passCount: number;
  /** 0-1: fraction of non-PASS responses starting with agreement markers */
  agreementRatio: number;
}

export interface ReflectionOptions {
  autoReflection: boolean;
  reflectionInterval: number;
  /** Wave number of the most recent reflection, if any */
  lastReflectionWave?: number;
}

interface WaveResponse {
  agentName: string;
  content: string;
  isPass: boolean;
}

// ============================================================================
// Agreement markers
// ============================================================================

const AGREEMENT_MARKERS = [
  'i agree',
  'good point',
  '+1',
  'agreed',
  'exactly',
  'absolutely',
  'that is correct',
  "that's correct",
  'you are right',
  "you're right",
  'well said',
  'i concur',
  'totally agree',
  'completely agree',
  'strongly agree',
];

// ============================================================================
// 4-gram helpers
// ============================================================================

/**
 * Split text into lower-cased word tokens, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Extract all overlapping 4-grams from a token list as joined strings.
 */
function extract4Grams(tokens: string[]): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= tokens.length - 4; i++) {
    grams.add(tokens.slice(i, i + 4).join(' '));
  }
  return grams;
}

/**
 * Compute repeat ratio: fraction of 4-grams in the current wave texts
 * that also appear in any previous wave text.
 */
function computeRepeatRatio(currentTexts: string[], previousTexts: string[]): number {
  if (previousTexts.length === 0 || currentTexts.length === 0) return 0;

  // Build a set of all 4-grams from previous waves
  const prevGrams = new Set<string>();
  for (const text of previousTexts) {
    for (const gram of extract4Grams(tokenize(text))) {
      prevGrams.add(gram);
    }
  }

  if (prevGrams.size === 0) return 0;

  // Count how many 4-grams from current wave appear in previous waves
  const currentGrams = new Set<string>();
  for (const text of currentTexts) {
    for (const gram of extract4Grams(tokenize(text))) {
      currentGrams.add(gram);
    }
  }

  if (currentGrams.size === 0) return 0;

  let overlap = 0;
  for (const gram of currentGrams) {
    if (prevGrams.has(gram)) overlap++;
  }

  return overlap / currentGrams.size;
}

/**
 * Count bullet points and headings in current wave texts that are not
 * present in any previous wave text (rough proxy for "new ideas").
 */
function countNewIdeas(currentTexts: string[], previousTexts: string[]): number {
  const ideaLineRe = /^(?:\s*[-*+]|\s*#{1,6})\s+(.+)/gm;

  const prevLines = new Set<string>();
  for (const text of previousTexts) {
    let m: RegExpExecArray | null;
    const re = /^(?:\s*[-*+]|\s*#{1,6})\s+(.+)/gm;
    while ((m = re.exec(text)) !== null) {
      prevLines.add(m[1].trim().toLowerCase());
    }
  }

  let count = 0;
  for (const text of currentTexts) {
    let m: RegExpExecArray | null;
    const re = new RegExp(ideaLineRe.source, 'gm');
    while ((m = re.exec(text)) !== null) {
      const line = m[1].trim().toLowerCase();
      if (!prevLines.has(line)) count++;
    }
  }

  return count;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute quality signals for a completed wave.
 *
 * @param wave - The wave index (0-based)
 * @param responses - All participant responses for this wave
 * @param previousWaveTexts - Concatenated text from all prior waves (for repeat detection)
 */
export function computeWaveQuality(
  wave: number,
  responses: WaveResponse[],
  previousWaveTexts: string[],
): WaveQualityScore {
  const passResponses = responses.filter((r) => r.isPass);
  const activeResponses = responses.filter((r) => !r.isPass);

  // Average response length (word count) — only non-PASS responses
  const avgResponseLength =
    activeResponses.length === 0
      ? 0
      : activeResponses.reduce((sum, r) => sum + tokenize(r.content).length, 0) /
        activeResponses.length;

  // Agreement ratio — fraction of non-PASS responses that start with agreement markers
  const agreementRatio =
    activeResponses.length === 0
      ? 0
      : activeResponses.filter((r) => {
          const lower = r.content.toLowerCase().trimStart();
          return AGREEMENT_MARKERS.some((marker) => lower.startsWith(marker));
        }).length / activeResponses.length;

  // Current wave texts (non-PASS only)
  const currentTexts = activeResponses.map((r) => r.content);

  // Repeat ratio via 4-gram overlap
  const repeatRatio = computeRepeatRatio(currentTexts, previousWaveTexts);

  // New ideas count
  const newIdeasCount = countNewIdeas(currentTexts, previousWaveTexts);

  return {
    wave,
    newIdeasCount,
    avgResponseLength,
    repeatRatio,
    passCount: passResponses.length,
    agreementRatio,
  };
}

/**
 * Determine whether a reflection wave should be injected.
 *
 * Returns true when:
 * - autoReflection is enabled
 * - The last 2 consecutive scores both have repeatRatio > 0.5 AND
 *   avgResponseLength is declining (last < second-to-last)
 * - Enough waves have passed since the last reflection (reflectionInterval)
 */
export function shouldTriggerReflection(
  recentScores: WaveQualityScore[],
  options: ReflectionOptions,
): boolean {
  if (!options.autoReflection) return false;
  if (recentScores.length < 2) return false;

  const last = recentScores[recentScores.length - 1];
  const prev = recentScores[recentScores.length - 2];

  // Both recent waves must show high repetition
  if (last.repeatRatio <= 0.5 || prev.repeatRatio <= 0.5) return false;

  // Response length must be declining
  if (last.avgResponseLength >= prev.avgResponseLength) return false;

  // Respect reflectionInterval: don't trigger again too soon
  if (options.lastReflectionWave !== undefined) {
    const wavesSinceLast = last.wave - options.lastReflectionWave;
    if (wavesSinceLast < options.reflectionInterval) return false;
  }

  return true;
}

// ============================================================================
// Reflection prompt
// ============================================================================

/** Standard reflection prompt injected when a stall is detected. */
export const REFLECTION_PROMPT = `## Reflection Round
The moderator has paused for a meta-reflection.
Answer briefly (2-3 sentences each):
1. What key points have we agreed on?
2. What question is blocking progress?
3. What perspective has been missing?
Do NOT repeat previous arguments.`;
