import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock createTaskEvent before importing the module under test
vi.mock('@/lib/services/task-event-service', () => ({
  createTaskEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
}));

import { createTaskEvent } from '@/lib/services/task-event-service';
import {
  buildInterruptionNote,
  recordInterruptionEvent,
  type InFlightTool,
} from '../interruption-marker';

const mockCreateTaskEvent = vi.mocked(createTaskEvent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildInterruptionNote', () => {
  it('returns generic message when no in-flight tools', () => {
    const note = buildInterruptionNote([]);
    expect(note).toContain('interrupted mid-turn');
    expect(note).toContain('worker restart');
    expect(note).toContain('Verify');
  });

  it('includes tool name when one tool is in-flight', () => {
    const tools: InFlightTool[] = [
      { toolName: 'Bash', input: { command: 'pm2 restart agendo-worker' } },
    ];
    const note = buildInterruptionNote(tools);
    expect(note).toContain('Bash');
    expect(note).toContain('pm2 restart agendo-worker');
    expect(note).toContain('interrupted mid-turn');
  });

  it('includes multiple tool names when multiple tools in-flight', () => {
    const tools: InFlightTool[] = [
      { toolName: 'Bash', input: { command: 'npm test' } },
      { toolName: 'Read', input: { file_path: '/some/file.ts' } },
    ];
    const note = buildInterruptionNote(tools);
    expect(note).toContain('Bash');
    expect(note).toContain('Read');
  });

  it('truncates very long tool input', () => {
    const longInput = 'x'.repeat(200);
    const tools: InFlightTool[] = [{ toolName: 'Bash', input: { command: longInput } }];
    const note = buildInterruptionNote(tools);
    // Note should not contain the full 200-char string
    expect(note.length).toBeLessThan(400);
    expect(note).toContain('...');
  });

  it('message advises agent to verify last action', () => {
    const tools: InFlightTool[] = [{ toolName: 'Write', input: { file_path: '/tmp/test.ts' } }];
    const note = buildInterruptionNote(tools);
    expect(note).toMatch(/[Vv]erify|[Cc]heck/);
  });
});

describe('recordInterruptionEvent', () => {
  it('creates a task event with agent_note type', async () => {
    await recordInterruptionEvent('task-1', [], 'agent-1');
    expect(mockCreateTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        eventType: 'agent_note',
        actorType: 'system',
      }),
    );
  });

  it('includes the interruption note in the payload', async () => {
    const tools: InFlightTool[] = [{ toolName: 'Bash', input: { command: 'pm2 restart' } }];
    await recordInterruptionEvent('task-2', tools, 'agent-1');
    expect(mockCreateTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ note: expect.stringContaining('Bash') }),
      }),
    );
  });

  it('passes the agentId as actorId', async () => {
    await recordInterruptionEvent('task-3', [], 'my-agent-id');
    expect(mockCreateTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'my-agent-id' }),
    );
  });
});
