import { describe, it, expect } from 'vitest';
import {
  generateClaudeMcpConfig,
  generateCodexMcpConfig,
  generateGeminiMcpConfig,
  generateGeminiRestFallbackInstructions,
  generateProjectMcpJson,
  generateSessionMcpConfig,
  generateGeminiAcpMcpServers,
  toAcpFormat,
} from '../config-templates';
import type { ResolvedMcpServer } from '../config-templates';

describe('generateSessionMcpConfig', () => {
  const baseIdentity = {
    sessionId: 'sess-123',
    taskId: 'task-456',
    agentId: 'agent-789',
    projectId: 'proj-abc',
  };

  it('generates correct structure with all identity fields', () => {
    const result = generateSessionMcpConfig('/path/to/mcp-server.js', baseIdentity) as {
      mcpServers: {
        agendo: {
          command: string;
          args: string[];
          env: {
            AGENDO_URL: string;
            AGENDO_SESSION_ID: string;
            AGENDO_TASK_ID: string;
            AGENDO_AGENT_ID: string;
            AGENDO_PROJECT_ID: string;
          };
        };
      };
    };

    expect(result.mcpServers.agendo.command).toBe('node');
    expect(result.mcpServers.agendo.args).toEqual(['/path/to/mcp-server.js']);
    expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://localhost:4100');
    expect(result.mcpServers.agendo.env.AGENDO_SESSION_ID).toBe('sess-123');
    expect(result.mcpServers.agendo.env.AGENDO_TASK_ID).toBe('task-456');
    expect(result.mcpServers.agendo.env.AGENDO_AGENT_ID).toBe('agent-789');
    expect(result.mcpServers.agendo.env.AGENDO_PROJECT_ID).toBe('proj-abc');
  });

  it('coerces null taskId and projectId to empty string', () => {
    const result = generateSessionMcpConfig('/path/to/mcp-server.js', {
      ...baseIdentity,
      taskId: null,
      projectId: null,
    }) as {
      mcpServers: {
        agendo: {
          env: { AGENDO_TASK_ID: string; AGENDO_PROJECT_ID: string };
        };
      };
    };

    expect(result.mcpServers.agendo.env.AGENDO_TASK_ID).toBe('');
    expect(result.mcpServers.agendo.env.AGENDO_PROJECT_ID).toBe('');
  });

  it('respects AGENDO_URL env var', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://custom:9000';

    try {
      const result = generateSessionMcpConfig('/path/to/server.js', baseIdentity) as {
        mcpServers: { agendo: { env: { AGENDO_URL: string } } };
      };
      expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://custom:9000');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });
});

describe('generateClaudeMcpConfig', () => {
  it('generates correct structure', () => {
    const config = generateClaudeMcpConfig('/path/to/mcp-server.js') as {
      mcpServers: {
        agendo: {
          command: string;
          args: string[];
          env: { AGENDO_URL: string };
        };
      };
    };

    expect(config.mcpServers['agendo'].command).toBe('node');
    expect(config.mcpServers['agendo'].args).toEqual(['/path/to/mcp-server.js']);
    expect(config.mcpServers['agendo'].env.AGENDO_URL).toBe('http://localhost:4100');
  });

  it('respects AGENDO_URL env var', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://custom:9000';

    try {
      const config = generateClaudeMcpConfig('/path/to/server.js') as {
        mcpServers: {
          agendo: { env: { AGENDO_URL: string } };
        };
      };
      expect(config.mcpServers['agendo'].env.AGENDO_URL).toBe('http://custom:9000');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });
});

describe('generateCodexMcpConfig', () => {
  it('generates valid TOML format', () => {
    const toml = generateCodexMcpConfig('/path/to/mcp-server.js');

    expect(toml).toContain('[mcp_servers.agendo]');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/path/to/mcp-server.js"]');
    expect(toml).toContain('[mcp_servers.agendo.env]');
    expect(toml).toContain('AGENDO_URL = "http://localhost:4100"');
  });

  it('respects AGENDO_URL env var', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://custom:9000';

    try {
      const toml = generateCodexMcpConfig('/path/to/server.js');
      expect(toml).toContain('AGENDO_URL = "http://custom:9000"');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });
});

describe('generateGeminiMcpConfig', () => {
  it('generates correct structure', () => {
    const config = generateGeminiMcpConfig('/path/to/mcp-server.js') as {
      mcpServers: {
        agendo: {
          command: string;
          args: string[];
          env: { AGENDO_URL: string };
        };
      };
    };

    expect(config.mcpServers['agendo'].command).toBe('node');
    expect(config.mcpServers['agendo'].args).toEqual(['/path/to/mcp-server.js']);
    expect(config.mcpServers['agendo'].env.AGENDO_URL).toBe('http://localhost:4100');
  });

  it('respects AGENDO_URL env var', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://custom:9000';

    try {
      const config = generateGeminiMcpConfig('/path/to/server.js') as {
        mcpServers: {
          agendo: { env: { AGENDO_URL: string } };
        };
      };
      expect(config.mcpServers['agendo'].env.AGENDO_URL).toBe('http://custom:9000');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });
});

describe('generateProjectMcpJson', () => {
  it('generates correct structure with command, args, and env', () => {
    const result = generateProjectMcpJson('/path/to/mcp-server.js') as {
      mcpServers: {
        agendo: {
          command: string;
          args: string[];
          env: { AGENDO_URL: string };
        };
      };
    };

    expect(result.mcpServers.agendo.command).toBe('node');
    expect(result.mcpServers.agendo.args).toEqual(['/path/to/mcp-server.js']);
    expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://localhost:4100');
  });

  it('uses explicit agendoUrl argument when provided', () => {
    const result = generateProjectMcpJson('/path/to/mcp-server.js', 'http://explicit:8080') as {
      mcpServers: { agendo: { env: { AGENDO_URL: string } } };
    };

    expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://explicit:8080');
  });

  it('explicit agendoUrl argument takes precedence over AGENDO_URL env var', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://from-env:9000';

    try {
      const result = generateProjectMcpJson('/path/to/server.js', 'http://explicit:8080') as {
        mcpServers: { agendo: { env: { AGENDO_URL: string } } };
      };
      expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://explicit:8080');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });

  it('falls back to AGENDO_URL env var when no explicit url is given', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://from-env:9000';

    try {
      const result = generateProjectMcpJson('/path/to/server.js') as {
        mcpServers: { agendo: { env: { AGENDO_URL: string } } };
      };
      expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://from-env:9000');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });

  it('falls back to localhost default when neither argument nor env var is set', () => {
    const original = process.env.AGENDO_URL;
    delete process.env.AGENDO_URL;

    try {
      const result = generateProjectMcpJson('/path/to/server.js') as {
        mcpServers: { agendo: { env: { AGENDO_URL: string } } };
      };
      expect(result.mcpServers.agendo.env.AGENDO_URL).toBe('http://localhost:4100');
    } finally {
      if (original !== undefined) {
        process.env.AGENDO_URL = original;
      }
    }
  });

  it('only exposes AGENDO_URL in env (no session identity fields)', () => {
    const result = generateProjectMcpJson('/path/to/mcp-server.js') as {
      mcpServers: { agendo: { env: Record<string, string> } };
    };

    const envKeys = Object.keys(result.mcpServers.agendo.env);
    expect(envKeys).toEqual(['AGENDO_URL']);
    expect(envKeys).not.toContain('AGENDO_SESSION_ID');
    expect(envKeys).not.toContain('AGENDO_TASK_ID');
    expect(envKeys).not.toContain('AGENDO_AGENT_ID');
  });
});

// ---------------------------------------------------------------------------
// Additional server types used in multi-server tests
// ---------------------------------------------------------------------------
const stdioServer: ResolvedMcpServer = {
  name: 'context7',
  transportType: 'stdio',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp'],
  env: {},
};

const httpServer: ResolvedMcpServer = {
  name: 'figma',
  transportType: 'http',
  url: 'https://mcp.figma.com/mcp',
  headers: {},
};

const stdioServerWithEnv: ResolvedMcpServer = {
  name: 'my-tool',
  transportType: 'stdio',
  command: 'node',
  args: ['/path/to/tool.js'],
  env: { MY_KEY: 'my-value', OTHER: 'other-value' },
};

describe('generateSessionMcpConfig with additional servers', () => {
  const identity = {
    sessionId: 'sess-123',
    taskId: 'task-456',
    agentId: 'agent-789',
    projectId: 'proj-abc',
  };

  it('should include only agendo when no additional servers', () => {
    const result = generateSessionMcpConfig('/path/to/server.js', identity, []) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(result.mcpServers)).toEqual(['agendo']);
  });

  it('should merge stdio servers into config', () => {
    const result = generateSessionMcpConfig('/path/to/server.js', identity, [stdioServer]) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };

    expect(result.mcpServers).toHaveProperty('agendo');
    expect(result.mcpServers).toHaveProperty('context7');
    expect(result.mcpServers['context7'].command).toBe('npx');
    expect(result.mcpServers['context7'].args).toEqual(['-y', '@upstash/context7-mcp']);
  });

  it('should merge http servers into Claude config', () => {
    const result = generateSessionMcpConfig('/path/to/server.js', identity, [httpServer]) as {
      mcpServers: Record<string, { type?: string; url?: string }>;
    };

    expect(result.mcpServers).toHaveProperty('agendo');
    expect(result.mcpServers).toHaveProperty('figma');
    expect(result.mcpServers['figma']).toHaveProperty('type', 'http');
    expect(result.mcpServers['figma']).toHaveProperty('url', 'https://mcp.figma.com/mcp');
  });

  it('should merge env from additional stdio servers', () => {
    const result = generateSessionMcpConfig('/path/to/server.js', identity, [
      stdioServerWithEnv,
    ]) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };

    expect(result.mcpServers['my-tool'].env).toMatchObject({
      MY_KEY: 'my-value',
      OTHER: 'other-value',
    });
  });

  it('backward-compat: omitting additionalServers still returns agendo only', () => {
    const result = generateSessionMcpConfig('/path/to/server.js', identity) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(result.mcpServers)).toEqual(['agendo']);
  });
});

describe('generateGeminiAcpMcpServers with additional servers', () => {
  const identity = {
    sessionId: 'sess-123',
    taskId: 'task-456',
    agentId: 'agent-789',
    projectId: 'proj-abc',
  };

  it('should include only agendo when no additional servers', () => {
    const result = generateGeminiAcpMcpServers('/path/to/server.js', identity, []);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('agendo');
  });

  it('should append stdio servers in ACP format', () => {
    const result = generateGeminiAcpMcpServers('/path/to/server.js', identity, [
      stdioServerWithEnv,
    ]);

    expect(result).toHaveLength(2);
    const tool = result.find((s) => s.name === 'my-tool');
    expect(tool).toBeDefined();
    expect(tool!.command).toBe('node');
    expect(tool!.args).toEqual(['/path/to/tool.js']);
    // env must be in ACP {name, value} array format
    expect(tool!.env).toContainEqual({ name: 'MY_KEY', value: 'my-value' });
    expect(tool!.env).toContainEqual({ name: 'OTHER', value: 'other-value' });
  });

  it('should skip http servers (Gemini ACP only supports stdio)', () => {
    const result = generateGeminiAcpMcpServers('/path/to/server.js', identity, [httpServer]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('agendo');
  });

  it('should handle mixed stdio and http servers, only including stdio', () => {
    const result = generateGeminiAcpMcpServers('/path/to/server.js', identity, [
      stdioServer,
      httpServer,
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toContain('agendo');
    expect(result.map((s) => s.name)).toContain('context7');
    expect(result.map((s) => s.name)).not.toContain('figma');
  });

  it('backward-compat: omitting additionalServers still returns agendo only', () => {
    const result = generateGeminiAcpMcpServers('/path/to/server.js', identity);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('agendo');
  });
});

describe('toAcpFormat', () => {
  it('should convert stdio server to ACP format', () => {
    const result = toAcpFormat(stdioServerWithEnv);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-tool');
    expect(result!.command).toBe('node');
    expect(result!.args).toEqual(['/path/to/tool.js']);
    expect(result!.env).toContainEqual({ name: 'MY_KEY', value: 'my-value' });
    expect(result!.env).toContainEqual({ name: 'OTHER', value: 'other-value' });
  });

  it('should convert stdio server with empty env to ACP format', () => {
    const result = toAcpFormat(stdioServer);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('context7');
    expect(result!.env).toEqual([]);
  });

  it('should return null for http servers', () => {
    const result = toAcpFormat(httpServer);

    expect(result).toBeNull();
  });
});

describe('generateGeminiRestFallbackInstructions', () => {
  it('contains curl examples', () => {
    const instructions = generateGeminiRestFallbackInstructions();

    expect(instructions).toContain('curl');
    expect(instructions).toContain('/api/tasks');
    expect(instructions).toContain('/api/agents');
    expect(instructions).toContain('POST');
    expect(instructions).toContain('PATCH');
  });

  it('uses default URL', () => {
    const original = process.env.AGENDO_URL;
    delete process.env.AGENDO_URL;

    try {
      const instructions = generateGeminiRestFallbackInstructions();
      expect(instructions).toContain('http://localhost:4100');
    } finally {
      if (original !== undefined) {
        process.env.AGENDO_URL = original;
      }
    }
  });

  it('respects AGENDO_URL env var', () => {
    const original = process.env.AGENDO_URL;
    process.env.AGENDO_URL = 'http://custom:9000';

    try {
      const instructions = generateGeminiRestFallbackInstructions();
      expect(instructions).toContain('http://custom:9000');
    } finally {
      if (original === undefined) {
        delete process.env.AGENDO_URL;
      } else {
        process.env.AGENDO_URL = original;
      }
    }
  });
});
