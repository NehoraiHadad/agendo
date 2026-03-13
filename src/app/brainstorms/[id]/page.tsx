export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { RoomClient } from '@/components/brainstorms/room-client';

export default async function BrainstormRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let room;
  try {
    room = await getBrainstorm(id);
  } catch {
    notFound();
  }

  return (
    // Negative margins cancel the p-4/sm:p-6 from AppShell's <main> element,
    // giving the brainstorm room a full-height, padding-free container
    // identical to the session detail view.
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden -m-4 sm:-m-6">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] bg-[oklch(0.085_0_0)]">
        <Link
          href="/brainstorms"
          className="flex items-center justify-center size-7 rounded-lg text-muted-foreground/50 hover:text-foreground/80 hover:bg-white/[0.06] transition-colors"
          aria-label="Back to brainstorms"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-foreground/90 truncate">{room.title}</h1>
          {room.project && (
            <p className="text-[10px] text-muted-foreground/40 truncate">
              {room.project.name}
              {room.task && ` · ${room.task.title}`}
            </p>
          )}
        </div>
      </div>

      {/* Room content */}
      <RoomClient room={room} />
    </div>
  );
}
