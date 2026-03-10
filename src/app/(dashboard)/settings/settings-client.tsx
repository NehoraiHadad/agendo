'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Settings, Bot, Server, FileCode } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentCards } from '@/components/settings/agent-cards';
import { McpServerCards } from '@/components/settings/mcp-server-cards';
import { ConfigEditorClient } from '../config/config-editor-client';
import type { Agent, McpServer } from '@/lib/types';

interface SettingsClientProps {
  agents: Agent[];
  mcpServers: McpServer[];
  projects: { id: string; name: string; rootPath: string }[];
}

const tabs = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
  { id: 'config', label: 'Config Files', icon: FileCode },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function SettingsClient({ agents, mcpServers, projects }: SettingsClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTab = (searchParams.get('tab') as TabId) || 'agents';
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    const url = tab === 'agents' ? '/settings' : `/settings?tab=${tab}`;
    router.replace(url, { scroll: false });
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Page header */}
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] overflow-hidden shrink-0 mb-4 sm:mb-5">
        <div
          className="h-[2px] w-full"
          style={{
            background:
              'linear-gradient(90deg, oklch(0.7 0.18 280 / 0.6) 0%, oklch(0.6 0.2 260 / 0.1) 100%)',
          }}
        />
        <div className="flex items-center gap-3 px-4 py-3">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.15) 0%, oklch(0.6 0.2 260 / 0.08) 100%)',
              border: '1px solid oklch(0.7 0.18 280 / 0.12)',
            }}
          >
            <Settings className="h-4 w-4 text-primary/70" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-foreground/90">Settings</h1>
            <p className="text-[11px] text-muted-foreground/35 mt-0.5">
              Manage agents, MCP servers, and configuration files
            </p>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4 px-0.5 shrink-0 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabChange(tab.id)}
            className={cn(
              'flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 whitespace-nowrap',
              activeTab === tab.id
                ? 'bg-primary/[0.12] text-primary'
                : 'text-muted-foreground/50 hover:text-foreground/70 hover:bg-white/[0.04]',
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'agents' && <AgentCards initialAgents={agents} />}
        {activeTab === 'mcp' && <McpServerCards initialServers={mcpServers} />}
        {activeTab === 'config' && <ConfigEditorClient projects={projects} />}
      </div>
    </div>
  );
}
