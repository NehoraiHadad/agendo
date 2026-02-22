'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CopyButton } from '@/components/ui/copy-button';

interface McpConfigCardProps {
  agent: { id: string; mcpEnabled: boolean };
}

interface ToolConfig {
  format: string;
  filename: string;
  content: object | string;
}

interface Configs {
  claude: ToolConfig;
  codex: ToolConfig;
  gemini: ToolConfig;
}

function configToString(config: ToolConfig): string {
  if (typeof config.content === 'string') return config.content;
  return JSON.stringify(config.content, null, 2);
}

export function McpConfigCard({ agent }: McpConfigCardProps) {
  const [enabled, setEnabled] = useState(agent.mcpEnabled);
  const [saving, setSaving] = useState(false);
  const [configs, setConfigs] = useState<Configs | null>(null);

  useEffect(() => {
    fetch('/api/mcp/config')
      .then((r) => r.json())
      .then((body: { data: Configs }) => setConfigs(body.data))
      .catch(() => {
        // non-critical — UI degrades gracefully
      });
  }, []);

  async function toggleMcp(value: boolean) {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpEnabled: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEnabled(value);
      toast.success(value ? 'MCP enabled' : 'MCP disabled');
    } catch {
      toast.error('Failed to update MCP setting');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch
          checked={enabled}
          onCheckedChange={toggleMcp}
          disabled={saving}
          id="mcp-enabled"
        />
        <label
          htmlFor="mcp-enabled"
          className="text-sm text-muted-foreground cursor-pointer select-none"
        >
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
      </div>

      {configs ? (
        <Tabs defaultValue="claude">
          <TabsList className="mb-3">
            <TabsTrigger value="claude">Claude</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
            <TabsTrigger value="gemini">Gemini</TabsTrigger>
          </TabsList>

          {(['claude', 'codex', 'gemini'] as const).map((tool) => {
            const cfg = configs[tool];
            const text = configToString(cfg);
            return (
              <TabsContent key={tool} value={tool} className="mt-0">
                <div className="relative rounded-md bg-muted/50 border border-white/[0.06]">
                  <div className="absolute top-2 right-2">
                    <CopyButton text={text} />
                  </div>
                  <pre className="p-4 pr-10 text-xs font-mono text-muted-foreground overflow-auto max-h-64 whitespace-pre-wrap break-all">
                    {text}
                  </pre>
                </div>
                <p className="mt-2 text-xs text-muted-foreground/60">
                  Add to{' '}
                  <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                    {cfg.filename}
                  </code>
                </p>
              </TabsContent>
            );
          })}
        </Tabs>
      ) : (
        <p className="text-xs text-muted-foreground/60">Loading config snippets…</p>
      )}
    </div>
  );
}
