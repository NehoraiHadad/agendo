/**
 * Shared analysis helpers used by both the route (GET/POST) and the worker.
 */

export interface AICapabilitySuggestion {
  key: string;
  label: string;
  description: string;
  commandTokens: string[];
  argsSchema: {
    properties?: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  dangerLevel: 0 | 1 | 2 | 3;
}

export function buildAnalysisPrompt(toolName: string, helpText: string | null): string {
  const helpSection = helpText
    ? `\nHere is the tool's --help output for reference:\n---\n${helpText.slice(0, 3000)}\n---\n`
    : '';
  return `Suggest the 5 most useful everyday CLI capabilities for the "${toolName}" tool in a developer task management system.${helpSection}
Return ONLY a valid JSON array — no markdown fences, no explanation, no other text.
Each item must have this exact shape:

[
  {
    "key": "commit",
    "label": "Commit",
    "description": "Record staged changes with a message",
    "commandTokens": ["${toolName}", "commit", "-m", "{{message}}"],
    "argsSchema": {
      "properties": {
        "message": { "type": "string", "description": "Commit message" }
      },
      "required": ["message"]
    },
    "dangerLevel": 1
  }
]

Rules:
- Use {{argName}} as a whole token when a value must be supplied by the user
- dangerLevel: 0 = read-only, 1 = modifies local state, 2 = affects remote/shared, 3 = destructive/irreversible
- argsSchema.properties keys must exactly match the {{placeholders}} used in commandTokens
- Commands with no user-provided args use argsSchema: {}
- Return ONLY the JSON array`;
}

export function extractJsonArray(raw: string): AICapabilitySuggestion[] {
  // Unwrap claude/gemini JSON wrapper if present: { result: "..." } or { response: "..." }
  try {
    const wrapper = JSON.parse(raw) as { result?: string; response?: string };
    const inner = wrapper.result ?? wrapper.response;
    if (typeof inner === 'string') return extractJsonArray(inner);
  } catch {
    /* not a JSON wrapper */
  }

  // Strip markdown code fences
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();

  // Try parsing the stripped content directly
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed as AICapabilitySuggestion[];
  } catch {
    /* fall through */
  }

  // Try extracting a JSON array with regex
  const match = stripped.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed as AICapabilitySuggestion[];
    } catch {
      /* not valid JSON */
    }
  }

  throw new Error('No JSON array found in AI response');
}
