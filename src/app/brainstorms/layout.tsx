import { AppShell } from '@/components/layout/app-shell';

/**
 * Layout for brainstorm room pages.
 * Uses AppShell for the sidebar + mobile header, but overrides the
 * default `overflow-y-auto p-4` on <main> by nesting children inside a
 * full-height flex container that suppresses padding.
 *
 * Note: AppShell's <main> is `flex flex-col flex-1 min-h-0 overflow-y-auto p-4 sm:p-6`.
 * The brainstorm room needs full-height scroll-free layout (like the session detail view),
 * so we set the children to `flex-1 min-h-0 flex flex-col overflow-hidden -m-4 sm:-m-6`.
 */
export default function BrainstormsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
