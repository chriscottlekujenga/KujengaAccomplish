import { useEffect, useState } from 'react';
import type { SftpSite } from '@accomplish_ai/agent-core/common';
import { useAccomplish } from '@/lib/accomplish';

export function SftpSitesSection() {
  const accomplish = useAccomplish();
  const [sites, setSites] = useState<SftpSite[]>([]);
  const [name, setName] = useState('WordPress site');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [remoteRoot, setRemoteRoot] = useState('/');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { accomplish.getSftpSites().then(setSites).catch((err) => setError(String(err))); }, [accomplish]);
  const add = async () => {
    try {
      setError(null);
      const saved = await accomplish.saveSftpSite({ name, host, username, port: 22, remoteRoot, privateKeyPath: privateKeyPath || undefined, isEnabled: true });
      setSites((current) => [...current.filter((site) => site.id !== saved.id), saved]);
      setHost(''); setUsername(''); setPrivateKeyPath('');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  return <section className="rounded-lg border border-border p-3 space-y-3">
    <div><h3 className="text-sm font-medium">WordPress SFTP</h3><p className="text-xs text-muted-foreground">Give tasks secure, folder-limited access to edit WordPress files. Authentication uses your SSH key or SSH agent; no password is stored.</p></div>
    <div className="grid grid-cols-2 gap-2"><input className="rounded border bg-background px-2 py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Site name" /><input className="rounded border bg-background px-2 py-1 text-sm" value={host} onChange={(e) => setHost(e.target.value)} placeholder="SFTP host" /><input className="rounded border bg-background px-2 py-1 text-sm" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" /><input className="rounded border bg-background px-2 py-1 text-sm" value={remoteRoot} onChange={(e) => setRemoteRoot(e.target.value)} placeholder="Remote WordPress folder" /></div>
    <input className="w-full rounded border bg-background px-2 py-1 text-sm" value={privateKeyPath} onChange={(e) => setPrivateKeyPath(e.target.value)} placeholder="Optional private-key file path" />
    <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={add}>Add SFTP site</button>
    {error && <p className="text-xs text-destructive">{error}</p>}
    {sites.map((site) => <div key={site.id} className="flex items-center justify-between text-sm"><span>{site.name} · {site.username}@{site.host} · {site.remoteRoot}</span><button className="text-destructive" onClick={() => accomplish.deleteSftpSite(site.id).then(() => setSites((current) => current.filter((item) => item.id !== site.id)))}>Remove</button></div>)}
  </section>;
}
