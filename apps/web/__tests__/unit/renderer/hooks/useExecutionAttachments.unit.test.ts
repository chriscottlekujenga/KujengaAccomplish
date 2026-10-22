/**
 * Unit tests for the execution-attachments drop flow (Phase 3 M2 T3).
 *
 * Covers the file-attachment routing decision:
 *   - Electron: dropped files always carry local paths → processDroppedFiles
 *     receives the extracted paths (unchanged desktop behavior).
 *   - Browser: drag-dropped File objects cannot reveal local paths, so a
 *     drop that produced files but no paths re-opens the AUTHORIZED host
 *     picker via processDroppedFiles([]) (plan §6 M2.3); picker cancel or a
 *     no-file drop never mutates attachments.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { FileAttachmentInfo } from '@accomplish_ai/agent-core/common';
import { useExecutionAttachments } from '@/pages/execution/useExecutionAttachments';
import { MAX_FILES } from '@/lib/fileUtils';

type AccomplishParam = Parameters<typeof useExecutionAttachments>[0];

const getShell = () => window as unknown as { accomplishShell?: unknown };

const setShell = (electron: boolean) => {
  getShell().accomplishShell = electron
    ? { version: 'test', platform: 'linux', isElectron: true }
    : undefined;
};

const makeAttachment = (index: number): FileAttachmentInfo => ({
  id: `att-${index}`,
  name: `file-${index}.md`,
  path: `/home/chris/file-${index}.md`,
  type: 'text',
  size: 3,
});

/** Shim-accurate: getFilePath is present but throws like the gateway stub. */
function makeShimThrownGetFilePath(): (file: File) => string {
  return () => {
    throw new Error('Method "getFilePath" is not yet supported over the HTTP gateway shim');
  };
}

function makeDropEvent(files: Array<{ name?: string; path?: string }>): React.DragEvent {
  const fakeFiles = files.map((f) => {
    const file = { name: f.name ?? 'dropped.txt' } as File & { path: string };
    if (f.path !== undefined) {
      file.path = f.path;
    }
    return file;
  });
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      items: null,
      files: fakeFiles,
    },
  } as unknown as React.DragEvent;
}

function mountHook(mock: Record<string, unknown>) {
  return renderHook(() => useExecutionAttachments(mock as unknown as AccomplishParam));
}

describe('useExecutionAttachments — drop flow (M2 T3)', () => {
  const savedShell = getShell().accomplishShell;

  afterEach(() => {
    getShell().accomplishShell = savedShell;
    vi.clearAllMocks();
  });

  it('Electron drop with paths routes the extracted paths to processDroppedFiles (unchanged behavior)', async () => {
    setShell(true);
    const picked = [makeAttachment(0)];
    const getFilePath = vi.fn((file: File) => (file as File & { path: string }).path);
    const processDroppedFiles = vi.fn(async () => picked);
    const mock = { pickFiles: vi.fn(async () => []), getFilePath, processDroppedFiles };
    const { result } = mountHook(mock);

    const event = makeDropEvent([
      { path: '/home/chris/notes.txt' },
      { path: '/home/chris/todo.md' },
    ]);
    await act(async () => {
      await result.current.handleDrop(event);
    });

    expect(getFilePath).toHaveBeenCalledTimes(2);
    expect(processDroppedFiles).toHaveBeenCalledTimes(1);
    expect(processDroppedFiles).toHaveBeenCalledWith([
      '/home/chris/notes.txt',
      '/home/chris/todo.md',
    ]);
    expect(result.current.attachments).toEqual(picked);
    expect(mock.pickFiles).not.toHaveBeenCalled();
  });

  it('browser drop without paths re-opens the authorized picker via processDroppedFiles([]) and appends its result', async () => {
    setShell(false);
    const picked = [makeAttachment(0), makeAttachment(1)];
    const getFilePath = makeShimThrownGetFilePath();
    const processDroppedFiles = vi.fn(async () => picked);
    const pickFiles = vi.fn(async () => [] as FileAttachmentInfo[]);
    const mock = { pickFiles, getFilePath, processDroppedFiles };
    const { result } = mountHook(mock);

    const event = makeDropEvent([{ name: 'dropped.png' }, { name: 'dropped2.pdf' }]);
    await act(async () => {
      await result.current.handleDrop(event);
    });

    // Exactly ONE picker reroute for the whole drop, with the unusable
    // paths argument emptied — not one call per dropped file.
    expect(processDroppedFiles).toHaveBeenCalledTimes(1);
    expect(processDroppedFiles).toHaveBeenCalledWith([]);
    expect(result.current.attachments).toEqual(picked);
    // The reroute must go THROUGH processDroppedFiles, not the ambient
    // pickFiles handler (handlePickFiles is wired to the picker button).
    expect(pickFiles).not.toHaveBeenCalled();
  });

  it('picker cancel on a browser drop leaves attachments unchanged', async () => {
    setShell(false);
    const getFilePath = makeShimThrownGetFilePath();
    const processDroppedFiles = vi.fn(async () => [] as FileAttachmentInfo[]);
    const { result } = mountHook({ getFilePath, processDroppedFiles });

    const event = makeDropEvent([{ name: 'dropped.txt' }]);
    await act(async () => {
      await result.current.handleDrop(event);
    });

    expect(processDroppedFiles).toHaveBeenCalledWith([]);
    expect(result.current.attachments).toEqual([]);
  });

  it('a drop that produced no files at all never opens the picker', async () => {
    setShell(false);
    const processDroppedFiles = vi.fn(async () => [] as FileAttachmentInfo[]);
    const { result } = mountHook({ processDroppedFiles });

    const event = makeDropEvent([]);
    await act(async () => {
      await result.current.handleDrop(event);
    });

    expect(processDroppedFiles).not.toHaveBeenCalled();
    expect(result.current.attachments).toEqual([]);
  });

  it('Electron keeps the silent return when a drop yields no usable paths', async () => {
    setShell(true);
    const getFilePath = vi.fn((file: File) => (file as File & { path?: string }).path);
    const processDroppedFiles = vi.fn(async () => [makeAttachment(0)]);
    const { result } = mountHook({ getFilePath, processDroppedFiles });

    const event = makeDropEvent([{ name: 'no-path.bin' }]);
    await act(async () => {
      await result.current.handleDrop(event);
    });

    expect(processDroppedFiles).not.toHaveBeenCalled();
    expect(result.current.attachments).toEqual([]);
  });

  it('reroute results are still truncated to MAX_FILES', async () => {
    setShell(false);
    const getFilePath = makeShimThrownGetFilePath();
    const picked = Array.from({ length: MAX_FILES + 2 }, (_, i) => makeAttachment(i));
    const processDroppedFiles = vi.fn(async () => picked);
    const { result } = mountHook({ getFilePath, processDroppedFiles });

    const event = makeDropEvent([{ name: 'a.txt' }]);
    await act(async () => {
      await result.current.handleDrop(event);
    });

    expect(processDroppedFiles).toHaveBeenCalledWith([]);
    expect(result.current.attachments).toHaveLength(MAX_FILES);
    expect(result.current.attachments.map((a) => a.id)).toEqual(
      Array.from({ length: MAX_FILES }, (_, i) => `att-${i}`),
    );
  });

  it('picker reroute failures are caught and logged (attachments unchanged)', async () => {
    setShell(false);
    const getFilePath = makeShimThrownGetFilePath();
    const processDroppedFiles = vi.fn(async () => {
      throw new Error('picker exploded');
    });
    const { result } = mountHook({ getFilePath, processDroppedFiles });

    const event = makeDropEvent([{ name: 'a.txt' }]);
    await act(async () => {
      await expect(result.current.handleDrop(event)).resolves.toBeUndefined();
    });

    expect(result.current.attachments).toEqual([]);
  });
});
