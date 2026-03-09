'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plug, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-types';

interface ConnectRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectRepoDialog({ open, onOpenChange }: ConnectRepoDialogProps) {
  const router = useRouter();
  const [source, setSource] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSource('');
      setError('');
    }
    onOpenChange(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!source.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setError('');
    try {
      const result = await apiFetch<{ data: { sessionId: string } }>('/api/integrations', {
        method: 'POST',
        body: JSON.stringify({ source: source.trim() }),
      });
      onOpenChange(false);
      router.push('/sessions/' + result.data.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start integration');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex items-center justify-center size-7 rounded-md bg-emerald-500/10 shrink-0">
              <Plug className="size-3.5 text-emerald-400" />
            </span>
            Add Integration
          </DialogTitle>
        </DialogHeader>

        {/* What happens */}
        <div className="mx-4 mt-1 px-3 py-2.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-xs text-muted-foreground/70 font-mono leading-relaxed">
          <span className="text-emerald-500/70">→</span> analyze source · classify type
          <br />
          <span className="text-emerald-500/70">→</span> save plan · spawn implementer
          <br />
          <span className="text-emerald-500/70">→</span> commit + push notification
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <DialogBody className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label
                htmlFor="int-source"
                className="text-xs text-muted-foreground uppercase tracking-wider"
              >
                What to integrate <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="int-source"
                required
                autoFocus
                rows={3}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={
                  'https://github.com/owner/tool\nhttps://npmjs.com/package/some-lib\nadd a linear integration with task sync'
                }
                className="font-mono text-sm resize-none"
              />
              <p className="text-[11px] text-muted-foreground/40">
                URL, package name, or a description — the agent figures the rest out.
              </p>
            </div>

            {error && (
              <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
                {error}
              </p>
            )}
          </DialogBody>

          <DialogFooter className="mt-4">
            <Button
              type="submit"
              disabled={!source.trim() || isSubmitting}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white border-0"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Plug className="size-4 mr-2" />
                  Analyze &amp; Integrate
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
