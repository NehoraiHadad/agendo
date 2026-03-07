# Model Discovery Research Findings

> Research date: 2026-03-07
> Task: Find official model listing methods for Claude, Codex, and Gemini CLIs

## Summary

| CLI         | Official `list-models` command?                                                       | Best method                                           | Fragility |
| ----------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------- |
| Claude Code | No (feature request [#12612](https://github.com/anthropics/claude-code/issues/12612)) | `strings` binary + grep (unchanged)                   | High      |
| Codex CLI   | **Yes** - `model/list` JSON-RPC via app-server                                        | app-server protocol (IMPLEMENTED)                     | Low       |
| Gemini CLI  | No                                                                                    | `require()` models.js from gemini-cli-core (IMPROVED) | Medium    |

## Claude Code CLI

### What exists

- `--model <model>` flag to set model (aliases: `opus`, `sonnet`, `haiku`, or full IDs like `claude-opus-4-6`)
- `/model` interactive slash command (picker UI, not programmatic)
- `/status` shows current model
- Anthropic API `GET /v1/models` (needs `ANTHROPIC_API_KEY` + `anthropic-version` header)

### What doesn't exist

- No `claude model list` subcommand
- No `claude config` model listing
- No stream-json protocol method for model listing
- Feature request filed: [#12612](https://github.com/anthropics/claude-code/issues/12612)

### Current approach (kept, with commentary)

The `strings` binary + `grep` approach is the only option without requiring an API key. The Claude CLI binary embeds `descriptionForModel` strings for the picker UI. This is fragile but works reliably for now.

**Alternative considered - Anthropic API**: `GET https://api.anthropic.com/v1/models` returns all API models with `id`, `display_name`, `created_at`. Requires `X-Api-Key` header. This would be the ideal solution but we'd need access to the user's API key (Claude Code uses its own OAuth auth, not API keys). Could be added as a future enhancement if API key becomes available.

### Bug fixed

**Claude adapter was not passing `--model` flag.** The model resolved by `getDefaultModel()` was stored on the session but never forwarded to the CLI. Fixed in `claude-adapter.ts:launch()` - now passes `--model opts.model` like Gemini and Codex adapters already do.

## Codex CLI

### What exists - MAJOR DISCOVERY

**`model/list` JSON-RPC method in app-server protocol** - this is the same protocol used by VS Code, macOS app, and JetBrains plugins. Tested and working.

Request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "model/list", "params": {} }
```

Response includes rich model metadata:

```typescript
type Model = {
  id: string; // e.g. "gpt-5.3-codex"
  model: string; // same as id
  displayName: string;
  description: string;
  hidden: boolean; // filter these out
  isDefault: boolean; // marks the default model
  upgrade: string | null; // successor model if deprecated
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: Array<'text' | 'image'>;
  supportsPersonality: boolean;
};
```

Supports pagination (`cursor`, `limit`) and `includeHidden` flag.

### What doesn't exist

- No `codex models` subcommand
- No `codex config list` model info
- OpenAI API `GET /v1/models` returns ALL OpenAI models, not just Codex-supported ones

### Implementation

Primary: `codex app-server` + `model/list` JSON-RPC (sends initialize + model/list via stdin, parses NDJSON response).
Fallback: `~/.codex/models_cache.json` (auto-refreshed by CLI, well-structured but undocumented).

## Gemini CLI

### What exists

- `--model`/`-m` flag to set model (aliases: `auto`, `pro`, `flash`, `flash-lite`)
- `/model` interactive command (picker UI, not programmatic)
- `--list-extensions` flag exists but no `--list-models`
- `@google/gemini-cli-core` npm package exports model constants

### What doesn't exist

- No `gemini --list-models` or `gemini models` command
- No ACP protocol method for model listing (checked initialize response)
- No headless model query flag

### Implementation (IMPROVED)

Previous: regex parsing of `models.js` source text (fragile, breaks on minification).
New: `require()` the models.js module directly as a Node.js module. This:

- Survives minification, whitespace changes, and constant reordering
- Provides access to all exports including `VALID_GEMINI_MODELS` Set, auto aliases, preview models
- Still depends on internal constant naming but is much more robust

Exported constants used:

- `DEFAULT_GEMINI_MODEL` - stable pro (e.g. `gemini-2.5-pro`)
- `PREVIEW_GEMINI_MODEL` - preview pro (e.g. `gemini-3-pro-preview`)
- `DEFAULT_GEMINI_FLASH_MODEL` - flash (e.g. `gemini-2.5-flash`)
- `DEFAULT_GEMINI_FLASH_LITE_MODEL` - flash lite (e.g. `gemini-2.5-flash-lite`)
- `PREVIEW_GEMINI_MODEL_AUTO` / `DEFAULT_GEMINI_MODEL_AUTO` - auto aliases
- `VALID_GEMINI_MODELS` - Set of all valid model IDs

## API Endpoints (for future reference)

All three providers have REST APIs for model listing, but all require provider-specific API keys:

| Provider  | Endpoint             | Auth                                          |
| --------- | -------------------- | --------------------------------------------- |
| Anthropic | `GET /v1/models`     | `X-Api-Key` + `anthropic-version: 2023-06-01` |
| OpenAI    | `GET /v1/models`     | `Authorization: Bearer $OPENAI_API_KEY`       |
| Google    | `GET /v1beta/models` | API key or OAuth                              |

These could be used as fallbacks if API keys become available to the worker process.

## Changes Made

1. **`claude-adapter.ts`** - Added `--model opts.model` to `buildArgs()` in `launch()` method
2. **`model-service.ts`** - Codex: primary method now uses `model/list` JSON-RPC via app-server (falls back to cache file). Gemini: switched from regex parsing to `require()` module import. Claude: unchanged (no better option exists). Reorganized helper functions for clarity.
