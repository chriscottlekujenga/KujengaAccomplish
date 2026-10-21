/**
 * Native Linux file & folder selection — zenity dialogs, spawned by the host.
 *
 * Replaces the Electron `dialog.showOpenDialog` pickers for the Firefox
 * shell (FIREFOX_MIGRATION_PLAN §9 Phase 2). A browser `File` object cannot
 * reveal local paths, so pickers are the only path-based attachment route.
 *
 * Mirrors the Electron handler semantics in
 * `apps/desktop/src/main/ipc/handlers/file-handlers.ts`:
 *   - folders: single directory path or null on cancel
 *   - files: max 5, max 10 MB each, text/code content pre-read
 *   - paths restricted to the user's home directory
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const MAX_ATTACHMENT_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_PICKED_FILES = 5;

export interface FileAttachmentInfo {
  id: string;
  name: string;
  path: string;
  type: 'image' | 'text' | 'code' | 'pdf' | 'other';
  size: number;
  content?: string;
}

type ExecFn = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

const defaultExec: ExecFn = (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('zenity', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout });
    });
  });
};

const TEXT_EXTS = ['txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'xml', 'html', 'css'];
const CODE_EXTS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'cs',
  'swift',
  'kt',
  'sh',
  'bash',
  'zsh',
  'fish',
];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

function detectFileType(ext: string): FileAttachmentInfo['type'] {
  if (IMAGE_EXTS.includes(ext)) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (CODE_EXTS.includes(ext)) {
    return 'code';
  }
  if (TEXT_EXTS.includes(ext)) {
    return 'text';
  }
  return 'other';
}

/** Paths are restricted to the user's home, like the Electron handler. */
function validatePath(filePath: string): void {
  const home = homedir();
  if (!path.isAbsolute(filePath) || !path.resolve(filePath).startsWith(home)) {
    throw new Error(`File path is outside allowed directories: ${path.basename(filePath)}`);
  }
}

function buildFileAttachmentInfo(filePath: string): FileAttachmentInfo {
  validatePath(filePath);
  const stat = statSync(filePath);
  if (stat.size > MAX_ATTACHMENT_FILE_SIZE) {
    throw new Error(`File ${path.basename(filePath)} exceeds the 10 MB size limit.`);
  }
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const type = detectFileType(ext);
  const info: FileAttachmentInfo = {
    id: randomUUID(),
    name: path.basename(filePath),
    path: filePath,
    type,
    size: stat.size,
  };
  if (type === 'text' || type === 'code') {
    try {
      info.content = readFileSync(filePath, 'utf-8');
    } catch {
      /* non-fatal — content stays undefined */
    }
  }
  return info;
}

/**
 * Open a folder-selection dialog. Returns the absolute path, or null when
 * the user cancels.
 */
export async function pickFolder(exec: ExecFn = defaultExec): Promise<string | null> {
  const result = await exec(['--file-selection', '--directory']);
  if (result.code !== 0) {
    return null;
  }
  const folder = result.stdout.trim();
  if (!folder) {
    return null;
  }
  validatePath(folder);
  return folder;
}

/**
 * Open a multi-file selection dialog. Returns attachment descriptors
 * (max 5 files, 10 MB each), or an empty array on cancel.
 */
export async function pickFiles(exec: ExecFn = defaultExec): Promise<FileAttachmentInfo[]> {
  const result = await exec(['--file-selection', '--multiple', '--separator=\n']);
  if (result.code !== 0) {
    return [];
  }
  const paths = result.stdout
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paths.length > MAX_PICKED_FILES) {
    throw new Error(`You can only select a maximum of ${MAX_PICKED_FILES} files.`);
  }
  return paths.map(buildFileAttachmentInfo);
}
