import { scanPATH } from './scanner';
import type { ScannedBinary } from './scanner';
import { identifyBinary } from './identifier';
import { getHelpText, quickParseHelp } from './schema-extractor';
import type { ParsedSchema } from './schema-extractor';
import { getPresetForBinary, AI_TOOL_PRESETS } from './presets';
import type { AIToolPreset } from './presets';

export interface DiscoveredTool {
  name: string;
  path: string;
  realPath: string;
  isSymlink: boolean;
  toolType: string;
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
 * Only processes binaries that match known AI agent presets or explicitly requested targets.
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

  // Sort by name
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return tools;
}

async function processBinary(
  binary: ScannedBinary,
  schemaTargets?: Set<string>,
  existingSlugs?: Set<string>,
  existingBinaryPaths?: Set<string>,
): Promise<DiscoveredTool> {
  const identity = await identifyBinary(binary.name, binary.path);
  const preset = getPresetForBinary(binary.name) ?? null;

  let schema: ParsedSchema | null = null;
  const shouldExtractSchema = preset !== null || schemaTargets?.has(binary.name);

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
    toolType: preset?.toolType ?? 'ai-agent',
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
