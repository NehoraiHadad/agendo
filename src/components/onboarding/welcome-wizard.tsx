'use client';

import { useState, useEffect } from 'react';
import { useFirstRun } from '@/hooks/use-first-run';
import { AgentStatusCard } from './agent-status-card';
import type { Agent } from '@/lib/types';
import { cn } from '@/lib/utils';

interface AgentDisplay {
  name: string;
  slug: string;
  icon: string;
  binaryName: string;
  authHint: string;
}

const KNOWN_AGENTS: AgentDisplay[] = [
  {
    name: 'Claude Code',
    slug: 'claude-code',
    icon: '🤖',
    binaryName: 'claude',
    authHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    name: 'Codex CLI',
    slug: 'codex',
    icon: '⚡',
    binaryName: 'codex',
    authHint: 'npm install -g @openai/codex',
  },
  {
    name: 'Gemini CLI',
    slug: 'gemini',
    icon: '✨',
    binaryName: 'gemini',
    authHint: 'npm install -g @google/gemini-cli',
  },
];

export function WelcomeWizard() {
  const { isFirstRun, dismiss } = useFirstRun();
  const [step, setStep] = useState(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isFirstRun) return;
    async function loadAgents() {
      try {
        const res = await fetch('/api/agents');
        if (res.ok) {
          const json = await res.json();
          setAgents(Array.isArray(json.data) ? json.data : []);
        }
      } catch {
        // ignore — show all as not found
      } finally {
        setLoading(false);
      }
    }
    loadAgents();
  }, [isFirstRun]);

  if (!isFirstRun) return null;

  function isAgentFound(binaryName: string): boolean {
    return agents.some(
      (a) =>
        a.slug.includes(binaryName) ||
        (a.binaryPath ?? '').endsWith(`/${binaryName}`) ||
        (a.binaryPath ?? '') === binaryName,
    );
  }

  function getAgentVersion(binaryName: string): string | undefined {
    const agent = agents.find(
      (a) =>
        a.slug.includes(binaryName) ||
        (a.binaryPath ?? '').endsWith(`/${binaryName}`) ||
        (a.binaryPath ?? '') === binaryName,
    );
    return agent?.version ?? undefined;
  }

  const totalSteps = 3;
  const isLastStep = step === totalSteps - 1;

  return (
    <>
      {/* Keyframe styles */}
      <style>{`
        @keyframes agendoFadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes agendoCardReveal {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes agendoScanLine {
          from { top: -1px; opacity: 0.8; }
          to { top: 100%; opacity: 0; }
        }
        @keyframes agendoTypewriter {
          from { clip-path: inset(0 100% 0 0); }
          to { clip-path: inset(0 0% 0 0); }
        }
        @keyframes agendoGlowPulse {
          0%, 100% { box-shadow: 0 0 20px rgba(0,255,136,0.15), 0 0 40px rgba(0,255,136,0.05); }
          50% { box-shadow: 0 0 30px rgba(0,255,136,0.35), 0 0 60px rgba(0,255,136,0.15); }
        }
        .agendo-wizard-step {
          animation: agendoFadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .agendo-cta-btn:hover {
          animation: agendoGlowPulse 1.5s ease-in-out infinite;
        }
        /* Expand dot tap target without changing visual size */
        .agendo-step-dot {
          position: relative;
          padding: 10px;
          margin: -10px;
        }
      `}</style>

      {/* Full-screen backdrop — scrollable so tall content on short viewports isn't clipped */}
      <div
        className="fixed inset-0 z-[60] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to agenDo"
      >
        {/* Grid background */}
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            backgroundColor: '#0a0a0f',
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px',
          }}
          aria-hidden="true"
        />

        {/* Ambient glow */}
        <div
          className="fixed top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse, rgba(0,255,136,0.04) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />

        {/* Centering wrapper — min-h-full so card centers on tall screens, natural flow on short */}
        <div className="relative flex min-h-full items-center justify-center p-4 py-8">
          {/* Wizard card */}
          <div
            className="relative w-full max-w-[680px] rounded-2xl overflow-hidden"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              backdropFilter: 'blur(24px)',
            }}
          >
            {/* Step progress bar */}
            <div className="absolute top-0 inset-x-0 h-px" aria-hidden="true">
              <div
                className="h-full bg-gradient-to-r from-[#00ff88]/60 to-[#00ff88]/20 transition-all duration-500 ease-out"
                style={{ width: `${((step + 1) / totalSteps) * 100}%` }}
              />
            </div>

            {/* Card content */}
            <div className="relative p-6 sm:p-10">
              {/* Background step number — smaller on mobile to avoid obscuring content */}
              <div
                className="absolute top-2 right-4 text-[72px] sm:text-[120px] font-bold leading-none select-none pointer-events-none"
                style={{
                  fontFamily: 'var(--font-jetbrains), monospace',
                  color: 'rgba(255,255,255,0.025)',
                }}
                aria-hidden="true"
              >
                {String(step + 1).padStart(2, '0')}
              </div>

              {/* Step 0: Welcome */}
              {step === 0 && (
                <div className="agendo-wizard-step space-y-5 sm:space-y-6">
                  {/* Logo / wordmark */}
                  <div className="flex items-center gap-3">
                    <div
                      className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-sm font-bold"
                      style={{
                        background: 'rgba(0,255,136,0.1)',
                        border: '1px solid rgba(0,255,136,0.2)',
                        fontFamily: 'var(--font-jetbrains), monospace',
                        color: '#00ff88',
                      }}
                    >
                      A
                    </div>
                    <span
                      className="text-sm font-medium text-white/40 uppercase tracking-widest"
                      style={{ fontFamily: 'var(--font-jetbrains), monospace' }}
                    >
                      agenDo
                    </span>
                  </div>

                  {/* Headline — clip-path typewriter avoids layout shift on narrow screens */}
                  <div>
                    <h1
                      className="text-2xl sm:text-4xl font-bold tracking-tight"
                      style={{
                        fontFamily: 'var(--font-jetbrains), monospace',
                        color: '#ffffff',
                        textShadow: '0 0 40px rgba(0,255,136,0.4)',
                        animationName: 'agendoTypewriter',
                        animationDuration: '1.2s',
                        animationTimingFunction: 'steps(28, end)',
                        animationDelay: '0.2s',
                        animationFillMode: 'both',
                      }}
                    >
                      Your agents are ready.
                    </h1>
                    <p
                      className="mt-3 text-sm sm:text-base leading-relaxed"
                      style={{
                        color: 'rgba(255,255,255,0.6)',
                        animationName: 'agendoFadeUp',
                        animationDuration: '0.5s',
                        animationDelay: '1.4s',
                        animationFillMode: 'both',
                        opacity: 0,
                      }}
                    >
                      agenDo orchestrates AI coding agents — Claude, Codex, Gemini, and more. Manage
                      tasks on a Kanban board, stream live output, and let agents collaborate on
                      your projects.
                    </p>
                  </div>

                  {/* Feature pills */}
                  <div
                    className="flex flex-wrap gap-2"
                    style={{
                      animationName: 'agendoFadeUp',
                      animationDuration: '0.5s',
                      animationDelay: '1.6s',
                      animationFillMode: 'both',
                      opacity: 0,
                    }}
                  >
                    {['Task management', 'Live streaming', 'Multi-agent', 'MCP tools'].map(
                      (label) => (
                        <span
                          key={label}
                          className="rounded-full px-3 py-1 text-xs font-medium"
                          style={{
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: 'rgba(255,255,255,0.5)',
                            fontFamily: 'var(--font-jetbrains), monospace',
                          }}
                        >
                          {label}
                        </span>
                      ),
                    )}
                  </div>
                </div>
              )}

              {/* Step 1: Agent Status */}
              {step === 1 && (
                <div className="agendo-wizard-step space-y-5 sm:space-y-6">
                  <div>
                    <p
                      className="text-xs font-medium uppercase tracking-widest mb-1"
                      style={{
                        color: '#00ff88',
                        fontFamily: 'var(--font-jetbrains), monospace',
                      }}
                    >
                      System scan
                    </p>
                    <h2
                      className="text-xl sm:text-3xl font-bold"
                      style={{
                        fontFamily: 'var(--font-jetbrains), monospace',
                        color: '#ffffff',
                      }}
                    >
                      Detected agents
                    </h2>
                    <p className="mt-2 text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
                      Agents installed on this system and registered with agenDo.
                    </p>
                  </div>

                  <div className="space-y-3">
                    {loading ? (
                      <div className="space-y-3">
                        {KNOWN_AGENTS.map((_, i) => (
                          <div
                            key={i}
                            className="h-16 rounded-lg animate-pulse"
                            style={{ background: 'rgba(255,255,255,0.03)' }}
                          />
                        ))}
                      </div>
                    ) : (
                      KNOWN_AGENTS.map((agent, i) => (
                        <AgentStatusCard
                          key={agent.slug}
                          name={agent.name}
                          slug={agent.slug}
                          icon={agent.icon}
                          found={isAgentFound(agent.binaryName)}
                          version={getAgentVersion(agent.binaryName)}
                          authHint={isAgentFound(agent.binaryName) ? undefined : agent.authHint}
                          animationDelay={i * 150}
                        />
                      ))
                    )}
                  </div>

                  {!loading && (
                    <p className="text-xs" style={{ color: 'rgba(255,255,255,0.25)' }}>
                      Agents can be added later via{' '}
                      <span
                        className="font-mono"
                        style={{ fontFamily: 'var(--font-jetbrains), monospace' }}
                      >
                        Settings → Agents
                      </span>
                      .
                    </p>
                  )}
                </div>
              )}

              {/* Step 2: Get Started */}
              {step === 2 && (
                <div className="agendo-wizard-step space-y-5 sm:space-y-6">
                  <div>
                    <p
                      className="text-xs font-medium uppercase tracking-widest mb-1"
                      style={{
                        color: '#00ff88',
                        fontFamily: 'var(--font-jetbrains), monospace',
                      }}
                    >
                      Ready
                    </p>
                    <h2
                      className="text-xl sm:text-3xl font-bold"
                      style={{
                        fontFamily: 'var(--font-jetbrains), monospace',
                        color: '#ffffff',
                        textShadow: '0 0 30px rgba(0,255,136,0.3)',
                      }}
                    >
                      Let&apos;s get started
                    </h2>
                    <p
                      className="mt-3 text-sm sm:text-base leading-relaxed"
                      style={{ color: 'rgba(255,255,255,0.5)' }}
                    >
                      Create your first project to organize tasks and assign agents. Projects define
                      the working directory your agents will operate in.
                    </p>
                  </div>

                  {/* Quick-start checklist */}
                  <div className="space-y-2">
                    {[
                      { n: '01', label: 'Create a project', detail: 'Set a root directory' },
                      { n: '02', label: 'Add a task', detail: 'Describe what to build' },
                      { n: '03', label: 'Start an agent session', detail: 'Watch it work live' },
                    ].map(({ n, label, detail }) => (
                      <div
                        key={n}
                        className="flex items-center gap-3 sm:gap-4 rounded-lg px-3 sm:px-4 py-3"
                        style={{
                          background: 'rgba(255,255,255,0.02)',
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <span
                          className="text-xs shrink-0 w-6 text-right"
                          style={{
                            fontFamily: 'var(--font-jetbrains), monospace',
                            color: '#00ff88',
                            opacity: 0.6,
                          }}
                        >
                          {n}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white/80">{label}</p>
                          <p className="text-xs text-white/30">{detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Navigation
                  Mobile: stacked column — CTA full-width, then Back + Skip in a row below
                  Desktop: single row with Back on left, Skip + CTA on right
              */}
              <div className="mt-7 sm:mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {/* CTA — full width on mobile, auto on desktop */}
                <button
                  onClick={isLastStep ? dismiss : () => setStep((s) => s + 1)}
                  className={cn(
                    'agendo-cta-btn relative rounded-xl text-sm font-semibold',
                    'transition-all duration-200 active:scale-[0.97]',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00ff88]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0f]',
                    // Full-width on mobile, auto on sm+; enforce min 44px height for thumb friendliness
                    'w-full sm:w-auto sm:order-last',
                    'min-h-[44px] px-6',
                  )}
                  style={{
                    background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
                    color: '#0a0a0f',
                    fontFamily: 'var(--font-jetbrains), monospace',
                    boxShadow: '0 0 20px rgba(0,255,136,0.2)',
                  }}
                >
                  {isLastStep ? 'Enter agenDo →' : 'Continue →'}
                </button>

                {/* Secondary actions row */}
                <div
                  className={cn(
                    'flex items-center gap-4',
                    // On mobile: space between Back and Skip; on desktop they're on the left
                    step > 0
                      ? 'justify-between sm:justify-start'
                      : 'justify-center sm:justify-start',
                  )}
                >
                  {step > 0 && (
                    <button
                      onClick={() => setStep((s) => s - 1)}
                      className="min-h-[44px] min-w-[44px] flex items-center text-sm font-medium transition-colors px-1"
                      style={{ color: 'rgba(255,255,255,0.35)' }}
                      onMouseOver={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                      onMouseOut={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.35)')}
                    >
                      ← Back
                    </button>
                  )}

                  <button
                    onClick={dismiss}
                    className="min-h-[44px] flex items-center text-sm transition-colors px-1"
                    style={{ color: 'rgba(255,255,255,0.25)' }}
                    onMouseOver={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}
                    onMouseOut={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.25)')}
                  >
                    Skip for now
                  </button>
                </div>
              </div>

              {/* Step dots — wrapped in padding for thumb-friendly tap area */}
              <div
                className="mt-5 sm:mt-6 flex items-center justify-center gap-3"
                role="tablist"
                aria-label="Wizard steps"
              >
                {Array.from({ length: totalSteps }, (_, i) => (
                  <button
                    key={i}
                    role="tab"
                    aria-selected={i === step}
                    aria-label={`Step ${i + 1}`}
                    onClick={() => setStep(i)}
                    // Invisible padding expands tap area to ~44px without affecting layout
                    className="agendo-step-dot flex items-center justify-center"
                  >
                    <span
                      className="block rounded-full transition-all duration-300"
                      style={{
                        width: i === step ? '20px' : '6px',
                        height: '6px',
                        background: i === step ? '#00ff88' : 'rgba(255,255,255,0.15)',
                        boxShadow: i === step ? '0 0 8px rgba(0,255,136,0.5)' : 'none',
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
