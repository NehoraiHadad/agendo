'use client';

import { useState, useCallback, useRef } from 'react';
import type { UpgradeStage } from '@/lib/upgrade/upgrade-manager';
import type { UpgradeSseEvent } from '@/lib/upgrade/upgrade-events';

export type UpgradePhase =
  | 'idle'
  | 'streaming' // SSE connected, receiving output
  | 'server-down' // SSE dropped (server restarting), polling /api/health
  | 'reconnected' // new version confirmed up
  | 'failed'; // script error or timeout

export interface UseUpgradeReturn {
  phase: UpgradePhase;
  stage: UpgradeStage;
  logLines: string[];
  targetVersion: string | null;
  error: string | null;
  elapsedPollSeconds: number;
  startUpgrade: (targetVersion: string) => Promise<void>;
  reset: () => void;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes

export function useUpgrade(): UseUpgradeReturn {
  const [phase, setPhase] = useState<UpgradePhase>('idle');
  const [stage, setStage] = useState<UpgradeStage>('idle');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [targetVersion, setTargetVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedPollSeconds, setElapsedPollSeconds] = useState(0);

  // Use refs so closures always see current values
  const stageRef = useRef<UpgradeStage>('idle');
  const phaseRef = useRef<UpgradePhase>('idle');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollElapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const updateStage = useCallback((s: UpgradeStage) => {
    stageRef.current = s;
    setStage(s);
  }, []);

  const updatePhase = useCallback((p: UpgradePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const appendLine = useCallback((line: string) => {
    setLogLines((prev) => [...prev, line]);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollElapsedRef.current) {
      clearInterval(pollElapsedRef.current);
      pollElapsedRef.current = null;
    }
  }, []);

  const beginPolling = useCallback(
    (expectedVersion: string) => {
      updatePhase('server-down');
      const pollStart = Date.now();
      setElapsedPollSeconds(0);

      pollElapsedRef.current = setInterval(() => {
        setElapsedPollSeconds(Math.floor((Date.now() - pollStart) / 1000));
      }, 1_000);

      pollTimerRef.current = setInterval(() => {
        if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
          stopPolling();
          updatePhase('failed');
          setError('Server did not come back online within 3 minutes.');
          return;
        }

        fetch('/api/health', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((body: { version?: string } | null) => {
            if (body?.version === expectedVersion) {
              stopPolling();
              updatePhase('reconnected');
              setTimeout(() => window.location.reload(), 1_500);
            }
          })
          .catch(() => {
            // Server still starting — expected, keep polling
          });
      }, POLL_INTERVAL_MS);
    },
    [updatePhase, stopPolling],
  );

  const startUpgrade = useCallback(
    async (version: string) => {
      setTargetVersion(version);
      setLogLines([]);
      setError(null);
      updateStage('preflight');
      updatePhase('streaming');

      // Start the upgrade job on the server
      let jobId: string;
      try {
        const res = await fetch('/api/upgrade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetVersion: version }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { jobId: string };
        jobId = data.jobId;
      } catch (err) {
        updatePhase('failed');
        setError(err instanceof Error ? err.message : 'Failed to start upgrade');
        return;
      }

      // Open SSE stream
      const es = new EventSource(`/api/upgrade/${jobId}/stream`);
      esRef.current = es;

      es.onmessage = (e: MessageEvent<string>) => {
        const evt = JSON.parse(e.data) as UpgradeSseEvent;

        if (evt.type === 'log') {
          appendLine(evt.line);
        } else if (evt.type === 'stage') {
          updateStage(evt.stage);
        } else if (evt.type === 'done') {
          es.close();
          // Server is about to restart — transition to polling immediately
          beginPolling(version);
        } else if (evt.type === 'error') {
          es.close();
          updatePhase('failed');
          setError(evt.message);
        }
      };

      es.onerror = () => {
        es.close();
        if (phaseRef.current !== 'streaming') return; // already handled
        const currentStage = stageRef.current;
        if (currentStage === 'restart' || currentStage === 'done') {
          // Expected drop during server restart
          beginPolling(version);
        } else {
          updatePhase('failed');
          setError('Connection lost unexpectedly during upgrade.');
        }
      };
    },
    [updatePhase, updateStage, appendLine, beginPolling],
  );

  const reset = useCallback(() => {
    stopPolling();
    esRef.current?.close();
    esRef.current = null;
    updatePhase('idle');
    updateStage('idle');
    setLogLines([]);
    setTargetVersion(null);
    setError(null);
    setElapsedPollSeconds(0);
  }, [stopPolling, updatePhase, updateStage]);

  return {
    phase,
    stage,
    logLines,
    targetVersion,
    error,
    elapsedPollSeconds,
    startUpgrade,
    reset,
  };
}
