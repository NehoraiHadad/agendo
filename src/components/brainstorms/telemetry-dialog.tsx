'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Shield, Eye, Send, X } from 'lucide-react';
import type { BrainstormTelemetryReport } from '@/lib/brainstorm/telemetry';

interface TelemetryDialogProps {
  report: BrainstormTelemetryReport | null;
  onDismiss: () => void;
}

/**
 * Dialog shown after a brainstorm completes, letting the user review
 * and optionally submit anonymous telemetry stats to GitHub.
 *
 * Key UX principles:
 * - Shows exactly what data will be sent (full JSON visible)
 * - Explains what is NOT included (no content, no identity)
 * - Requires explicit action to send
 * - Can be dismissed without sending
 * - Remembers "don't ask again" preference
 */
export function TelemetryDialog({ report, onDismiss }: TelemetryDialogProps) {
  const [showRawJson, setShowRawJson] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Check if GitHub telemetry is configured
  useEffect(() => {
    if (!report) return;
    fetch('/api/telemetry')
      .then((r) => r.json())
      .then((data: { data?: { githubEnabled?: boolean } }) => {
        setGithubEnabled(data.data?.githubEnabled ?? false);
      })
      .catch(() => setGithubEnabled(false));
  }, [report]);

  // Check localStorage for "don't ask again"
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const pref = localStorage.getItem('agendo-telemetry-dontask');
      if (pref === 'true') {
        setDontAskAgain(true);
      }
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!report) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });

      const data = (await res.json()) as {
        data?: { submitted?: boolean; issueUrl?: string };
        error?: { message?: string };
      };

      if (res.ok && data.data?.submitted) {
        setSubmitted(true);
        setIssueUrl(data.data.issueUrl ?? null);
      } else {
        setError(data.error?.message ?? 'Failed to submit telemetry');
      }
    } catch {
      setError('Network error — could not reach the server');
    } finally {
      setSubmitting(false);
    }
  }, [report]);

  const handleDismiss = useCallback(() => {
    if (dontAskAgain && typeof window !== 'undefined') {
      localStorage.setItem('agendo-telemetry-dontask', 'true');
    }
    onDismiss();
  }, [dontAskAgain, onDismiss]);

  // Don't show if: no report, or user opted out, or GitHub not configured
  if (!report || !githubEnabled) return null;
  if (
    typeof window !== 'undefined' &&
    localStorage.getItem('agendo-telemetry-dontask') === 'true'
  ) {
    return null;
  }

  const endEmoji =
    report.endState === 'converged'
      ? '✅'
      : report.endState === 'stalled'
        ? '⏸️'
        : report.endState === 'max_waves'
          ? '🔄'
          : '⏹️';

  return (
    <Dialog open onOpenChange={() => handleDismiss()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-green-500" />
            Share anonymous brainstorm stats?
          </DialogTitle>
          <DialogDescription>
            Help improve agendo by sharing anonymous statistics from this brainstorm session. No
            topic content, responses, or personal data is included.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="space-y-3 py-4">
            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
              Thanks! Telemetry submitted successfully.
            </p>
            {issueUrl && (
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-blue-500 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                View on GitHub
              </a>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className="rounded-md border p-3 space-y-1.5 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <span>{endEmoji}</span>
                <span>
                  {report.endState} — {report.totalWaves} waves, {report.totalParticipants}{' '}
                  participants
                </span>
              </div>
              <div className="text-muted-foreground space-y-0.5">
                <div>Agents: {report.agentSlugs.join(', ')}</div>
                <div>Duration: {report.totalDurationSec}s</div>
                <div>
                  Feedback: 👍 {report.feedbackCount.thumbsUp} 👎 {report.feedbackCount.thumbsDown}{' '}
                  🎯 {report.feedbackCount.focus}
                </div>
              </div>
            </div>

            {/* Privacy badge */}
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-green-600 border-green-300">
                <Shield className="h-3 w-3 mr-1" />
                Privacy safe
              </Badge>
              <span className="text-xs text-muted-foreground">
                Numbers and config only — no content, no names, no identity
              </span>
            </div>

            {/* Raw JSON toggle */}
            <button
              onClick={() => setShowRawJson(!showRawJson)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Eye className="h-3 w-3" />
              {showRawJson ? 'Hide' : 'View'} exact data that will be sent
            </button>

            {showRawJson && (
              <ScrollArea className="h-48 rounded-md border">
                <pre className="p-3 text-xs font-mono whitespace-pre-wrap">
                  {JSON.stringify(report, null, 2)}
                </pre>
              </ScrollArea>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {!submitted && (
            <>
              <label className="flex items-center gap-2 text-xs text-muted-foreground mr-auto">
                <input
                  type="checkbox"
                  checked={dontAskAgain}
                  onChange={(e) => setDontAskAgain(e.target.checked)}
                  className="rounded"
                />
                Don&apos;t ask again
              </label>
              <Button variant="ghost" size="sm" onClick={handleDismiss}>
                <X className="h-4 w-4 mr-1" />
                Skip
              </Button>
              <Button size="sm" onClick={handleSubmit} disabled={submitting}>
                <Send className="h-4 w-4 mr-1" />
                {submitting ? 'Sending...' : 'Share stats'}
              </Button>
            </>
          )}
          {submitted && (
            <Button variant="ghost" size="sm" onClick={handleDismiss}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
