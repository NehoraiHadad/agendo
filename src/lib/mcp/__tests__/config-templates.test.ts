import { describe, it, expect } from 'vitest';
import {
  generateClaudeMcpConfig,
  generateCodexMcpConfig,
  generateGeminiMcpConfig,
  generateGeminiRestFallbackInstructions,
  generateProjectMcpJson,
  generateSessionMcpConfig,
} from '../config-templates';

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
        'agendo': {
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
          'agendo': { env: { AGENDO_URL: string } };
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
        'agendo': {
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
          'agendo': { env: { AGENDO_URL: string } };
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
