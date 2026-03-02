'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { LayoutDashboard, ListTodo, Bot } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/agents', label: 'Agents', icon: Bot },
];

interface TaskResult {
  id: string;
  title: string;
  status: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tasks, setTasks] = useState<TaskResult[]>([]);
  const router = useRouter();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (search.length < 2) {
      const timer = setTimeout(() => setTasks([]), 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tasks?limit=5`);
        const json = await res.json();
        const filtered = (json.data as TaskResult[]).filter((t) =>
          t.title.toLowerCase().includes(search.toLowerCase()),
        );
        setTasks(filtered);
      } catch {
        setTasks([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      setSearch('');
      router.push(href);
    },
    [router],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      className="bg-[oklch(0.10_0_0)] border border-white/[0.10] rounded-xl shadow-2xl"
    >
      <CommandInput
        placeholder="Type a command or search..."
        value={search}
        onValueChange={setSearch}
        className="bg-transparent border-none"
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map((item) => (
            <CommandItem
              key={item.href}
              onSelect={() => navigate(item.href)}
              className="hover:bg-white/[0.05]"
            >
              <item.icon className="mr-2 h-4 w-4" />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {tasks.length > 0 && (
          <CommandGroup heading="Tasks">
            {tasks.map((task) => (
              <CommandItem
                key={task.id}
                onSelect={() => navigate(`/tasks/${task.id}`)}
                className="hover:bg-white/[0.05]"
              >
                <ListTodo className="mr-2 h-4 w-4" />
                <span className="truncate">{task.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
