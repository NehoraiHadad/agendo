import { describe, it, expect } from 'vitest';
import {
  generateClaudeMcpConfig,
  generateCodexMcpConfig,
  generateGeminiMcpConfig,
  generateGeminiRestFallbackInstructions,
} from '../config-templates';

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
