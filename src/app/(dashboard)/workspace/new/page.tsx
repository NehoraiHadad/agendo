'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, layout: { panels: [], gridCols: 2 } }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const body = (await res.json()) as { data: { id: string } };
      router.push(`/workspace/${body.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setIsCreating(false);
    }
  }

  return (
    <div className="max-w-md mx-auto pt-8">
      <h1 className="text-xl font-semibold text-foreground/90 mb-6">New Workspace</h1>

      <form onSubmit={handleCreate} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="workspace-name" className="text-sm text-foreground/70">
            Workspace name
          </label>
          <input
            id="workspace-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Feature Sprint, Bug Hunt…"
            autoFocus
            className="w-full rounded-lg border border-white/[0.10] bg-white/[0.04] px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/35 focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-colors"
            disabled={isCreating}
            maxLength={255}
          />
        </div>

        {error && <p className="text-sm text-red-400/80">{error}</p>}

        <div className="flex items-center gap-2 pt-2">
          <Button type="submit" disabled={!name.trim() || isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="size-3.5 mr-2 animate-spin" />
                Creating…
              </>
            ) : (
              'Create workspace'
            )}
          </Button>
          <Button variant="outline" asChild disabled={isCreating}>
            <Link href="/workspace">Cancel</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
