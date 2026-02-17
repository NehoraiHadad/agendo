import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from './sidebar';
import { CommandPalette } from '@/components/command-palette';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <CommandPalette />
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </TooltipProvider>
  );
}
