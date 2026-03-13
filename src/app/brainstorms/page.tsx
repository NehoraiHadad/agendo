export const dynamic = 'force-dynamic';

import { listBrainstorms } from '@/lib/services/brainstorm-service';
import { BrainstormList } from '@/components/brainstorms/brainstorm-list';

// eslint-disable-next-line react-refresh/only-export-components
export const metadata = { title: 'Brainstorms — agenDo' };

export default async function BrainstormsPage() {
  const rooms = await listBrainstorms();
  return (
    <div className="flex flex-col gap-6">
      <BrainstormList initialRooms={rooms} />
    </div>
  );
}
