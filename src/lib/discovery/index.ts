import { scanPATH } from './scanner';
import type { ScannedBinary } from './scanner';
import { identifyBinary } from './identifier';
import { classifyBinary } from './classifier';
import type { ToolType } from './classifier';
import { getHelpText, quickParseHelp } from './schema-extractor';
import type { ParsedSchema } from './schema-extractor';
import { getPresetForBinary, AI_TOOL_PRESETS } from './presets';
import type { AIToolPreset } from './presets';

export interface DiscoveredTool {
  name: string;
  path: string;
  realPath: string;
  isSymlink: boolean;
  toolType: ToolType;
  version: string | null;
  packageName: string | null;
  packageSection: string | null;
  description: string | null;
  fileType: string | null;
  schema: ParsedSchema | null;
  preset: AIToolPreset | null;
  isConfirmed: boolean;
}

/**
 * Run the full discovery pipeline.
 * Stages 1-3 run for ALL binaries. Stage 4 (schema) runs only for AI presets
 * and optionally for tools in `schemaTargets`.
 */
export async function runDiscovery(
  schemaTargets?: Set<string>,
  existingSlugs?: Set<string>,
  existingBinaryPaths?: Set<string>,
): Promise<DiscoveredTool[]> {
  console.log('[discovery] Stage 1: Scanning PATH...');
  const binaries = await scanPATH();
  console.log(`[discovery] Found ${binaries.size} executables.`);

  const tools: DiscoveredTool[] = [];

  // Only process binaries that match a known preset or are explicitly requested.
  // Processing all 1800+ PATH binaries is extremely slow (dpkg -S + apt-cache per binary).
  const presetNames = new Set(Object.keys(AI_TOOL_PRESETS));
  const entries = Array.from(binaries.values()).filter(
    (b) => presetNames.has(b.name) || schemaTargets?.has(b.name),
  );

  console.log(`[discovery] Stage 2: Processing ${entries.length} candidate binaries...`);

  await Promise.all(
    entries.map(async (binary) => {
      const result = await processBinary(binary, schemaTargets, existingSlugs, existingBinaryPaths);
      tools.push(result);
    }),
  );

  // Sort: AI agents first, then by name
  tools.sort((a, b) => {
    const typeOrder: Record<ToolType, number> = {
      'ai-agent': 0,
      'cli-tool': 1,
      'admin-tool': 2,
      'interactive-tui': 3,
      'shell-util': 4,
      daemon: 5,
    };
    const orderDiff = (typeOrder[a.toolType] ?? 9) - (typeOrder[b.toolType] ?? 9);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name);
  });

  return tools;
}

async function processBinary(
  binary: ScannedBinary,
  schemaTargets?: Set<string>,
  existingSlugs?: Set<string>,
  existingBinaryPaths?: Set<string>,
): Promise<DiscoveredTool> {
  const identity = await identifyBinary(binary.name, binary.path);
  const toolType = await classifyBinary({
    name: binary.name,
    packageSection: identity.packageSection,
  });
  const preset = getPresetForBinary(binary.name) ?? null;

  let schema: ParsedSchema | null = null;
  const shouldExtractSchema =
    preset !== null || schemaTargets?.has(binary.name) || toolType === 'ai-agent';

  if (shouldExtractSchema) {
    const helpText = await getHelpText(binary.name);
    if (helpText) {
      schema = quickParseHelp(helpText);
    }
  }

  const slug = binary.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const isConfirmed =
    (existingSlugs?.has(slug) ?? false) ||
    (existingBinaryPaths?.has(binary.path) ?? false) ||
    (existingBinaryPaths?.has(binary.realPath) ?? false);

  return {
    name: binary.name,
    path: binary.path,
    realPath: binary.realPath,
    isSymlink: binary.isSymlink,
    toolType: preset?.toolType ?? toolType,
    version: identity.version,
    packageName: identity.packageName,
    packageSection: identity.packageSection,
    description: preset?.metadata.description ?? identity.description,
    fileType: identity.fileType,
    schema,
    preset,
    isConfirmed,
  };
}
