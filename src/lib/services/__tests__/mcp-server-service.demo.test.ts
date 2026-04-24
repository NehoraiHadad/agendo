import { describe, it, expect } from 'vitest';
import {
  listMcpServers,
  getMcpServer,
  getMcpServerByName,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getProjectMcpServers,
  setProjectMcpOverride,
  removeProjectMcpOverride,
  resolveSessionMcpServers,
  resolveByMcpServerIds,
  importFromInstalledPlugins,
  ALL_DEMO_MCP_SERVERS,
  DEMO_MCP_AGENDO,
  DEMO_MCP_FILESYSTEM,
  DEMO_MCP_GITHUB,
} from '../mcp-server-service.demo';

describe('mcp-server-service.demo', () => {
  describe('fixtures', () => {
    it('exports 3 MCP server fixtures', () => {
      expect(ALL_DEMO_MCP_SERVERS).toHaveLength(3);
    });

    it('fixtures have required McpServer fields', () => {
      for (const server of ALL_DEMO_MCP_SERVERS) {
        expect(server.id).toBeTypeOf('string');
        expect(server.name).toBeTypeOf('string');
        expect(server.transportType).toBeOneOf(['stdio', 'http']);
        expect(server.enabled).toBeTypeOf('boolean');
        expect(server.isDefault).toBeTypeOf('boolean');
        expect(server.createdAt).toBeInstanceOf(Date);
        expect(server.updatedAt).toBeInstanceOf(Date);
      }
    });

    it('agendo-task-mcp is the default server', () => {
      expect(DEMO_MCP_AGENDO.isDefault).toBe(true);
      expect(DEMO_MCP_FILESYSTEM.isDefault).toBe(false);
      expect(DEMO_MCP_GITHUB.isDefault).toBe(false);
    });

    it('server names are believable', () => {
      const names = ALL_DEMO_MCP_SERVERS.map((s) => s.name);
      expect(names).toContain('agendo-task-mcp');
      expect(names).toContain('filesystem-mcp');
      expect(names).toContain('github-mcp');
    });
  });

  describe('listMcpServers', () => {
    it('returns all servers with no filter', async () => {
      const result = await listMcpServers();
      expect(result).toHaveLength(3);
    });

    it('filters by enabled=true', async () => {
      const result = await listMcpServers({ enabled: true });
      expect(result.every((s) => s.enabled)).toBe(true);
    });

    it('filters by enabled=false returns empty (all fixtures are enabled)', async () => {
      const result = await listMcpServers({ enabled: false });
      expect(result).toHaveLength(0);
    });
  });

  describe('getMcpServer', () => {
    it('returns server by id', async () => {
      const server = await getMcpServer(DEMO_MCP_AGENDO.id);
      expect(server?.name).toBe('agendo-task-mcp');
    });

    it('returns null for unknown id', async () => {
      const server = await getMcpServer('00000000-0000-0000-0000-000000000000');
      expect(server).toBeNull();
    });
  });

  describe('getMcpServerByName', () => {
    it('returns server by name', async () => {
      const server = await getMcpServerByName('filesystem-mcp');
      expect(server?.id).toBe(DEMO_MCP_FILESYSTEM.id);
    });

    it('returns null for unknown name', async () => {
      const server = await getMcpServerByName('nonexistent-mcp');
      expect(server).toBeNull();
    });
  });

  describe('createMcpServer', () => {
    it('returns a stub McpServer without throwing', async () => {
      const result = await createMcpServer({ name: 'test-mcp', transportType: 'stdio' });
      expect(result.name).toBe('test-mcp');
      expect(result.transportType).toBe('stdio');
      expect(result.id).toBeTypeOf('string');
    });
  });

  describe('updateMcpServer', () => {
    it('returns an updated server stub without throwing', async () => {
      const result = await updateMcpServer(DEMO_MCP_AGENDO.id, { description: 'Updated' });
      expect(result.id).toBe(DEMO_MCP_AGENDO.id);
      expect(result.description).toBe('Updated');
    });
  });

  describe('deleteMcpServer', () => {
    it('does not throw', async () => {
      await expect(deleteMcpServer(DEMO_MCP_AGENDO.id)).resolves.toBeUndefined();
    });
  });

  describe('getProjectMcpServers', () => {
    it('returns empty array', async () => {
      const result = await getProjectMcpServers('44444444-4444-4444-a444-444444444444');
      expect(result).toEqual([]);
    });
  });

  describe('setProjectMcpOverride', () => {
    it('does not throw', async () => {
      await expect(
        setProjectMcpOverride('44444444-4444-4444-a444-444444444444', DEMO_MCP_AGENDO.id, {
          enabled: true,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('removeProjectMcpOverride', () => {
    it('does not throw', async () => {
      await expect(
        removeProjectMcpOverride('44444444-4444-4444-a444-444444444444', DEMO_MCP_AGENDO.id),
      ).resolves.toBeUndefined();
    });
  });

  describe('resolveSessionMcpServers', () => {
    it('returns default servers only', async () => {
      const result = await resolveSessionMcpServers(null);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((s) => s.name)).toBe(true);
    });

    it('resolved servers have required shape', async () => {
      const result = await resolveSessionMcpServers('44444444-4444-4444-a444-444444444444');
      for (const s of result) {
        expect(s.name).toBeTypeOf('string');
        expect(s.transportType).toBeOneOf(['stdio', 'http']);
      }
    });
  });

  describe('resolveByMcpServerIds', () => {
    it('returns empty array for empty input', async () => {
      expect(await resolveByMcpServerIds([])).toEqual([]);
    });

    it('returns matching servers by id', async () => {
      const result = await resolveByMcpServerIds([DEMO_MCP_FILESYSTEM.id, DEMO_MCP_GITHUB.id]);
      expect(result).toHaveLength(2);
    });

    it('skips unknown ids silently', async () => {
      const result = await resolveByMcpServerIds(['00000000-0000-0000-0000-999999999999']);
      expect(result).toHaveLength(0);
    });
  });

  describe('importFromInstalledPlugins', () => {
    it('returns empty result without throwing', async () => {
      const result = await importFromInstalledPlugins();
      expect(result).toEqual({ imported: [], skipped: [], errors: [] });
    });
  });
});
