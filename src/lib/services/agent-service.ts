import { accessSync, constants } from 'node:fs';
import { db } from '@/lib/db';
import { agents, agentCapabilities } from '@/lib/db/schema';
import { eq, ilike, desc } from 'drizzle-orm';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/errors';
import type { Agent, NewAgent } from '@/lib/types';
import type { DiscoveredTool } from '@/lib/discovery';

interface CreateAgentInput {
  name: string;
  binaryPath: string;
  workingDir?: string | null;
  envAllowlist?: string[];
  maxConcurrent?: number;
  kind?: 'builtin' | 'custom';
  discoveryMethod?: 'preset' | 'path_scan' | 'manual';
  version?: string | null;
  packageName?: string | null;
  packageSection?: string | null;
  toolType?: string | null;
  mcpEnabled?: boolean;
  sessionConfig?: NewAgent['sessionConfig'];
  metadata?: NewAgent['metadata'];
  baseArgs?: string[];
}

interface UpdateAgentInput {
  name?: string;
  workingDir?: string | null;
  envAllowlist?: string[];
  maxConcurrent?: number;
  isActive?: boolean;
  mcpEnabled?: boolean;
  metadata?: NewAgent['metadata'];
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function validateBinaryPath(binaryPath: string): void {
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new ValidationError(`Binary not found or not executable: ${binaryPath}`, {
      field: 'binaryPath',
      path: binaryPath,
    });
  }
}

async function ensureUniqueSlug(baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let suffix = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(ilike(agents.slug, slug))
      .limit(1);

    if (existing.length === 0) return slug;
    suffix++;
    slug = `${baseSlug}-${suffix}`;
  }
}

export async function createAgent(data: CreateAgentInput): Promise<Agent> {
  validateBinaryPath(data.binaryPath);

  const slug = await ensureUniqueSlug(generateSlug(data.name));

  const [agent] = await db
    .insert(agents)
    .values({
      name: data.name,
      slug,
      binaryPath: data.binaryPath,
      workingDir: data.workingDir ?? null,
      envAllowlist: data.envAllowlist ?? [],
      maxConcurrent: data.maxConcurrent ?? 1,
      kind: data.kind ?? 'custom',
      discoveryMethod: data.discoveryMethod ?? 'manual',
      version: data.version ?? null,
      packageName: data.packageName ?? null,
      packageSection: data.packageSection ?? null,
      toolType: data.toolType ?? null,
      mcpEnabled: data.mcpEnabled ?? false,
      sessionConfig: data.sessionConfig ?? null,
      metadata: data.metadata ?? {},
      baseArgs: data.baseArgs ?? [],
    })
    .returning();

  return agent;
}

export async function createFromDiscovery(tool: DiscoveredTool): Promise<Agent> {
  const preset = tool.preset;

  const agent = await createAgent({
    name: preset?.displayName ?? tool.name,
    binaryPath: tool.path,
    kind: preset ? 'builtin' : 'custom',
    discoveryMethod: preset ? 'preset' : 'path_scan',
    version: tool.version,
    packageName: tool.packageName,
    packageSection: tool.packageSection,
    toolType: tool.toolType,
    mcpEnabled: preset?.mcpEnabled ?? false,
    envAllowlist: preset?.envAllowlist ?? [],
    maxConcurrent: preset?.maxConcurrent ?? 1,
    sessionConfig: preset?.sessionConfig ?? null,
    metadata: preset?.metadata ?? {},
  });

  // Create default capabilities from preset
  if (preset?.defaultCapabilities.length) {
    for (const cap of preset.defaultCapabilities) {
      await db.insert(agentCapabilities).values({
        agentId: agent.id,
        key: cap.key,
        label: cap.label,
        description: cap.description,
        source: 'preset',
        interactionMode: cap.interactionMode,
        promptTemplate: cap.promptTemplate,
        dangerLevel: cap.dangerLevel,
        timeoutSec: cap.timeoutSec,
        isEnabled: true,
      });
    }
  }
  // Create capabilities from parsed schema subcommands (non-preset tools)
  else if (tool.schema?.subcommands.length) {
    for (const subcmd of tool.schema.subcommands) {
      await db.insert(agentCapabilities).values({
        agentId: agent.id,
        key: subcmd.name,
        label: subcmd.name,
        description: subcmd.description,
        source: 'scan_help',
        interactionMode: 'template',
        commandTokens: [tool.name, subcmd.name],
        dangerLevel: 0,
        isEnabled: false,
      });
    }
  }

  return agent;
}

export async function getAgentById(id: string): Promise<Agent> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent) throw new NotFoundError('Agent', id);
  return agent;
}

export async function listAgents(): Promise<Agent[]> {
  return db
    .select()
    .from(agents)
    .orderBy(desc(agents.createdAt));
}

export async function updateAgent(id: string, data: UpdateAgentInput): Promise<Agent> {
  const [agent] = await db
    .update(agents)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, id))
    .returning();

  if (!agent) throw new NotFoundError('Agent', id);
  return agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const [deleted] = await db
    .delete(agents)
    .where(eq(agents.id, id))
    .returning({ id: agents.id });

  if (!deleted) throw new NotFoundError('Agent', id);
}

export async function getExistingSlugs(): Promise<Set<string>> {
  const rows = await db.select({ slug: agents.slug }).from(agents);
  return new Set(rows.map((r) => r.slug));
}
