'use client';

import {
  type ComponentType,
  type ReactNode,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useRouter } from 'next/navigation';
import { Search, ListTodo, FolderOpen, MessageSquare, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTaskBoardStore } from '@/lib/store/task-board-store';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  title: string;
  status?: string;
  meta?: string;
}

interface SearchData {
  tasks: SearchResult[];
  projects: SearchResult[];
  sessions: SearchResult[];
  plans: SearchResult[];
}

type GroupKey = keyof SearchData;

interface FlatItem {
  id: string;
  title: string;
  status?: string;
  meta?: string;
  href: string;
  group: GroupKey;
  globalIdx: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const GROUP_CONFIG: Record<
  GroupKey,
  {
    label: string;
    Icon: ComponentType<{ className?: string }>;
    href: (id: string) => string;
  }
> = {
  tasks: { label: 'TASKS', Icon: ListTodo, href: (_id) => `/tasks` },
  projects: { label: 'PROJECTS', Icon: FolderOpen, href: (id) => `/projects/${id}` },
  sessions: { label: 'SESSIONS', Icon: MessageSquare, href: (id) => `/sessions/${id}` },
  plans: { label: 'PLANS', Icon: FileText, href: (id) => `/plans/${id}` },
};

const STATUS_STYLES: Record<string, string> = {
  todo: 'bg-amber-400/15 text-amber-400/70',
  in_progress: 'bg-blue-400/15 text-blue-400/70',
  done: 'bg-emerald-400/15 text-emerald-400/70',
  cancelled: 'bg-white/[0.06] text-white/25',
  blocked: 'bg-red-400/15 text-red-400/70',
  active: 'bg-blue-400/15 text-blue-400/70',
  awaiting_input: 'bg-amber-400/15 text-amber-400/70',
  idle: 'bg-white/[0.06] text-white/25',
  ended: 'bg-white/[0.06] text-white/25',
  draft: 'bg-white/[0.06] text-white/25',
  ready: 'bg-emerald-400/15 text-emerald-400/70',
  executing: 'bg-blue-400/15 text-blue-400/70',
  stale: 'bg-amber-400/15 text-amber-400/70',
  archived: 'bg-white/[0.06] text-white/25',
};

const QUICK_LINKS: Array<{ id: string; title: string; href: string; group: GroupKey }> = [
  { id: 'ql-tasks', title: 'Tasks', href: '/tasks', group: 'tasks' },
  { id: 'ql-projects', title: 'Projects', href: '/projects', group: 'projects' },
  { id: 'ql-sessions', title: 'Sessions', href: '/sessions', group: 'sessions' },
  { id: 'ql-plans', title: 'Plans', href: '/plans', group: 'plans' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function highlight(text: string, query: string): ReactNode {
  if (!query || query.length < 2) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-transparent text-primary font-medium not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Build a flat list of all navigable items (search results or quick links)
  const flatItems = useMemo<FlatItem[]>(() => {
    if (query.length < 2 || !results) {
      return QUICK_LINKS.map((item, i) => ({ ...item, globalIdx: i }));
    }
    const items: FlatItem[] = [];
    let idx = 0;
    for (const [group, groupResults] of Object.entries(results) as [GroupKey, SearchResult[]][]) {
      for (const r of groupResults) {
        items.push({
          id: r.id,
          title: r.title,
          status: r.status,
          meta: r.meta,
          href: GROUP_CONFIG[group].href(r.id),
          group,
          globalIdx: idx++,
        });
      }
    }
    return items;
  }, [results, query]);

  // Pre-computed groups with start indices for rendering
  const groupedItems = useMemo(() => {
    if (query.length < 2 || !results) return null;
    let idx = 0;
    return (Object.entries(results) as [GroupKey, SearchResult[]][])
      .filter(([, items]) => items.length > 0)
      .map(([group, items]) => {
        const startIdx = idx;
        idx += items.length;
        return { group, items, startIdx };
      });
  }, [results, query]);

  // Listen to events from useCommandPalette()
  useEffect(() => {
    const handleOpen = () => setOpen(true);
    const handleToggle = () => setOpen((prev) => !prev);
    document.addEventListener('agendo:open-command-palette', handleOpen);
    document.addEventListener('agendo:toggle-command-palette', handleToggle);
    return () => {
      document.removeEventListener('agendo:open-command-palette', handleOpen);
      document.removeEventListener('agendo:toggle-command-palette', handleToggle);
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as Element)?.tagName ?? '')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Focus input and reset state on open/close
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setSelectedIndex(0);
    } else {
      setQuery('');
      setResults(null);
      setIsLoading(false);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        setResults(json.data as SearchData);
      } catch {
        setResults(null);
      } finally {
        setIsLoading(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [query]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [flatItems]);

  const selectTask = useTaskBoardStore((s) => s.selectTask);

  const navigate = useCallback(
    (href: string, taskId?: string) => {
      setOpen(false);
      router.push(href);
      if (taskId) {
        // Tasks open as a detail sheet via Zustand, not a separate page
        setTimeout(() => selectTask(taskId), 50);
      }
    },
    [router, selectTask],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatItems[selectedIndex];
        if (item) navigate(item.href, item.group === 'tasks' ? item.id : undefined);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    },
    [flatItems, selectedIndex, navigate],
  );

  if (!open) return null;

  const isSearching = query.length >= 2;
  const noResults = isSearching && results !== null && flatItems.length === 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/55"
        style={{ backdropFilter: 'blur(2px)' }}
        onClick={() => setOpen(false)}
      />

      {/* Palette */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="fixed z-50 top-[18%] left-1/2 -translate-x-1/2 w-[640px] max-w-[95vw] animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
        style={{
          background: '#0c0c14',
          border: '1px solid oklch(0.7 0.18 280 / 0.12)',
          borderRadius: '16px',
          boxShadow:
            '0 0 0 1px oklch(0.7 0.18 280/0.08), 0 32px 64px -8px rgba(0,0,0,0.9), 0 0 80px -20px oklch(0.7 0.18 280/0.15)',
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 h-14">
          <Search className="h-4 w-4 text-white/20 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks, projects, sessions, plans..."
            className="flex-1 bg-transparent text-[15px] font-mono text-white/85 placeholder:text-white/20 outline-none border-none"
            style={{ caretColor: 'oklch(0.7 0.18 280)' }}
          />
          {isLoading ? (
            <div className="h-3.5 w-3.5 rounded-full border border-white/20 border-t-primary/60 animate-spin shrink-0" />
          ) : (
            <kbd className="hidden sm:flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono text-white/20 bg-white/[0.04] border border-white/[0.06]">
              esc
            </kbd>
          )}
        </div>

        <div className="border-t border-white/[0.05]" />

        {/* Results area */}
        <div className="max-h-[400px] overflow-y-auto py-1.5">
          {noResults ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <Search className="h-6 w-6 text-white/10" />
              <p className="text-[12px] text-white/25">
                No results for <span className="text-white/40">&ldquo;{query}&rdquo;</span>
              </p>
            </div>
          ) : groupedItems && groupedItems.length > 0 ? (
            // Search results grouped by entity type
            groupedItems.map(({ group, items, startIdx }) => {
              const { label, Icon, href } = GROUP_CONFIG[group];
              return (
                <div key={group}>
                  <div className="px-4 py-1.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/20">
                    {label}
                  </div>
                  {items.map((item, i) => {
                    const itemIdx = startIdx + i;
                    const isSelected = itemIdx === selectedIndex;
                    return (
                      <ResultRow
                        key={item.id}
                        item={item}
                        isSelected={isSelected}
                        Icon={Icon}
                        query={query}
                        onClick={() =>
                          navigate(href(item.id), group === 'tasks' ? item.id : undefined)
                        }
                        onMouseEnter={() => setSelectedIndex(itemIdx)}
                      />
                    );
                  })}
                </div>
              );
            })
          ) : (
            // Idle state — quick links
            <div>
              <div className="px-4 py-1.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/20">
                Quick links
              </div>
              {QUICK_LINKS.map((item, i) => {
                const isSelected = i === selectedIndex;
                const { Icon } = GROUP_CONFIG[item.group];
                return (
                  <button
                    key={item.id}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-75 relative',
                      isSelected ? 'bg-primary/[0.08]' : 'hover:bg-white/[0.04]',
                    )}
                    onClick={() => navigate(item.href)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    {isSelected && <SelectionBar />}
                    <Icon
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        isSelected ? 'text-primary/60' : 'text-white/25',
                      )}
                    />
                    <span className="text-[13px] text-white/70">{item.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.04] px-4 py-2.5 flex items-center gap-5">
          {[
            { keys: ['↑', '↓'], label: 'navigate' },
            { keys: ['↵'], label: 'open' },
            { keys: ['esc'], label: 'close' },
          ].map(({ keys, label }) => (
            <span
              key={label}
              className="flex items-center gap-1.5 text-[10px] text-white/20 font-mono"
            >
              {keys.map((k) => (
                <kbd
                  key={k}
                  className="rounded px-1 py-0.5 text-[9px] bg-white/[0.04] border border-white/[0.06] leading-none"
                >
                  {k}
                </kbd>
              ))}
              <span className="text-white/15">{label}</span>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SelectionBar() {
  return (
    <span
      className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-r-full bg-primary"
      style={{ boxShadow: '2px 0 6px oklch(0.7 0.18 280 / 0.5)' }}
    />
  );
}

interface ResultRowProps {
  item: SearchResult;
  isSelected: boolean;
  Icon: ComponentType<{ className?: string }>;
  query: string;
  onClick: () => void;
  onMouseEnter: () => void;
}

function ResultRow({ item, isSelected, Icon, query, onClick, onMouseEnter }: ResultRowProps) {
  return (
    <button
      className={cn(
        'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-75 relative',
        isSelected ? 'bg-primary/[0.08]' : 'hover:bg-white/[0.04]',
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {isSelected && <SelectionBar />}
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0 transition-colors',
          isSelected ? 'text-primary/60' : 'text-white/25',
        )}
      />
      <span className="flex-1 min-w-0">
        <span className="text-[13px] text-white/85 truncate block">
          {highlight(item.title, query)}
        </span>
        {item.meta && (
          <span className="text-[11px] text-white/25 truncate block leading-tight">
            {item.meta}
          </span>
        )}
      </span>
      {item.status && (
        <span
          className={cn(
            'flex items-center shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]',
            STATUS_STYLES[item.status] ?? 'bg-white/[0.06] text-white/25',
          )}
        >
          {item.status.replace(/_/g, ' ')}
        </span>
      )}
    </button>
  );
}
