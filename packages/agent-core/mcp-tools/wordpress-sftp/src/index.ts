#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface Site { id: string; name: string; host: string; port: number; username: string; remoteRoot: string; privateKeyPath?: string }
const sites: Site[] = JSON.parse(process.env.WORDPRESS_SFTP_SITES || '[]');

function site(id: string): Site {
  const found = sites.find((candidate) => candidate.id === id);
  if (!found) throw new Error('Unknown SFTP site. Choose one returned by wordpress_sftp_sites.');
  return found;
}
function remotePath(connection: Site, requested = ''): string {
  const root = path.posix.normalize(connection.remoteRoot || '/');
  const candidate = path.posix.normalize(path.posix.join(root, requested.replace(/^\/+/, '')));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error('That path is outside this site\'s configured WordPress folder.');
  return candidate;
}
async function run(connection: Site, commands: string): Promise<string> {
  const args = ['-b', '-', '-P', String(connection.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (connection.privateKeyPath) args.push('-i', connection.privateKeyPath);
  args.push(`${connection.username}@${connection.host}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'sftp.exe' : 'sftp', args, { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    const timeout = setTimeout(() => child.kill(), 110000);
    child.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve([stdout, stderr].filter(Boolean).join('\n').trim()) : reject(new Error(stderr || `SFTP exited with code ${code}`)); });
    child.stdin.end(commands);
  });
}
function result(text: string) { return { content: [{ type: 'text' as const, text: text || 'Completed.' }] }; }

const server = new McpServer({ name: 'wordpress-sftp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('wordpress_sftp_sites', { description: 'List the configured WordPress SFTP sites available to this task.' }, async () => result(sites.map(({ id, name, host, username, remoteRoot }) => `- ${name} (${id}): ${username}@${host}, restricted to ${remoteRoot}`).join('\n') || 'No WordPress SFTP sites are configured.'));
server.registerTool('wordpress_sftp_list', { description: 'List files or folders inside a configured WordPress SFTP folder.', inputSchema: { site_id: z.string(), path: z.string().optional() } }, async ({ site_id, path: requested }) => result(await run(site(site_id), `ls -la ${remotePath(site(site_id), requested)}\n`)));
server.registerTool('wordpress_sftp_read', { description: 'Read a UTF-8 WordPress file through SFTP. Use only for text files.', inputSchema: { site_id: z.string(), path: z.string() } }, async ({ site_id, path: requested }) => { const connection = site(site_id); const local = path.join(os.tmpdir(), `accomplish-sftp-${Date.now()}`); try { await run(connection, `get ${remotePath(connection, requested)} ${local}\n`); return result(await fs.readFile(local, 'utf8')); } finally { await fs.rm(local, { force: true }); } });
server.registerTool('wordpress_sftp_write', { description: 'Create or replace a UTF-8 WordPress file through SFTP. Review the target path and content carefully before calling.', inputSchema: { site_id: z.string(), path: z.string(), content: z.string() } }, async ({ site_id, path: requested, content }) => { const connection = site(site_id); const local = path.join(os.tmpdir(), `accomplish-sftp-${Date.now()}`); try { await fs.writeFile(local, content, 'utf8'); await run(connection, `put ${local} ${remotePath(connection, requested)}\n`); return result(`Updated ${remotePath(connection, requested)}.`); } finally { await fs.rm(local, { force: true }); } });
server.registerTool('wordpress_sftp_delete', { description: 'Delete a WordPress file through SFTP. Use only when the user has explicitly asked to remove that exact file.', inputSchema: { site_id: z.string(), path: z.string() } }, async ({ site_id, path: requested }) => { const connection = site(site_id); const target = remotePath(connection, requested); await run(connection, `rm ${target}\n`); return result(`Deleted ${target}.`); });

async function main() { await server.connect(new StdioServerTransport()); }
main().catch((error) => { console.error('[wordpress-sftp] Fatal error:', error); process.exit(1); });
