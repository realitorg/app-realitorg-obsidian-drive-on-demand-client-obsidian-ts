import { describe, it, expect, vi } from 'vitest';
import { PullManager } from './pull-manager';
import { MirrorIndex, type MirrorEntry } from '../mirror/mirror-index';
import { SelectiveSyncState } from './selective-sync-state';
import { DriveClient } from '../drive/drive-client';
import type { VaultOps } from '../mirror/tree-mirror';
import type { PersistAdapter } from '../auth/token-store';
import type { HttpFn, HttpResponse } from '../http';
import { hashContent } from '../util/content-hash';
import { PathLocks } from '../util/path-locks';

function ad() { const raw: Record<string, unknown> = {}; const a: PersistAdapter = { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } }; return a; }
function driveObj() {
  const http = vi.fn<HttpFn>(async () => ({ status: 200, text: '{}', json: <T>() => ({}) as T }));
  return new DriveClient(http, async () => 'AT');
}
function vaultObj(local: string) {
  const writes: Array<{ path: string; content: string }> = [];
  const vault: VaultOps = { exists: async () => true, createFolder: async () => {}, createStub: async () => {}, writeText: async (p, d) => { writes.push({ path: p, content: d }); }, writeBinary: async () => {}, readText: async () => local, readBinary: async () => new ArrayBuffer(0), remove: async () => {}, isEmptyFolder: () => false, rename: async () => {}, listChildren: () => [] };
  return { vault, writes };
}
const ENTRY = (o: Partial<MirrorEntry> = {}): MirrorEntry => ({ driveId: 'D', mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true, ...o });

describe('PullManager.refreshFile', () => {
  async function edited(remoteContent: string, over: Record<string, unknown> = {}) {
    const index = new MirrorIndex(ad()); await index.load(); await index.set('n.md', ENTRY({ headRevisionId: 'r1', syncedHash: hashContent('base') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const drive = driveObj();
    const getRevision = vi.spyOn(drive, 'getRevision').mockResolvedValue({ headRevisionId: 'r2' });
    vi.spyOn(drive, 'readText').mockResolvedValue(remoteContent);
    const updateText = vi.spyOn(drive, 'updateText').mockResolvedValue('r3');
    const { vault, writes } = vaultObj('edit local');
    const pm = new PullManager({ vault, drive, index, state, now: () => 'L', ...over });
    return { pm, index, writes, updateText, getRevision };
  }

  it('modifs locales en attente d envoi → pas de rafraîchissement (l envoi s en charge)', async () => {
    const { pm, writes, getRevision } = await edited('autre', { hasLocalPending: () => true });
    expect(await pm.refreshFile('n.md')).toBe('up-to-date');
    expect(getRevision).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('révision changée mais contenu distant inchangé → pas de conflit, fichier ouvert pas réécrit', async () => {
    const { pm, index, writes, updateText } = await edited('base');
    expect(await pm.refreshFile('n.md')).toBe('up-to-date');
    expect(writes).toEqual([]);
    expect(updateText).not.toHaveBeenCalled();
    expect(index.get('n.md')?.headRevisionId).toBe('r2');
  });

  it('distant identique au local (notre propre envoi) → pas de conflit, rien réécrit', async () => {
    const { pm, index, writes } = await edited('edit local');
    expect(await pm.refreshFile('n.md')).toBe('up-to-date');
    expect(writes).toEqual([]);
    expect(index.get('n.md')?.syncedHash).toBe(hashContent('edit local'));
  });

  it('verrou partagé : un rafraîchissement attend l envoi en cours du même fichier', async () => {
    const locks = new PathLocks();
    const order: string[] = [];
    let release!: () => void;
    const pushing = locks.run('n.md', () => new Promise<void>((r) => { release = () => { order.push('push'); r(); }; }));
    const { pm } = await edited('base', { locks });
    const refreshing = pm.refreshFile('n.md').then(() => order.push('pull'));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    release();
    await Promise.all([pushing, refreshing]);
    expect(order).toEqual(['push', 'pull']);
  });

  it('up-to-date si la révision distante est identique', async () => {
    const index = new MirrorIndex(ad()); await index.load(); await index.set('n.md', ENTRY({ headRevisionId: 'r1' }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const drive = driveObj(); vi.spyOn(drive, 'getRevision').mockResolvedValue({ headRevisionId: 'r1' });
    const { vault } = vaultObj('local');
    expect(await new PullManager({ vault, drive, index, state }).refreshFile('n.md')).toBe('up-to-date');
  });

  it('pulled si distant a changé et local intact', async () => {
    const index = new MirrorIndex(ad()); await index.load(); await index.set('n.md', ENTRY({ headRevisionId: 'r1', syncedHash: hashContent('local') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const drive = driveObj();
    vi.spyOn(drive, 'getRevision').mockResolvedValue({ headRevisionId: 'r2' });
    vi.spyOn(drive, 'readText').mockResolvedValue('depuis drive');
    const { vault, writes } = vaultObj('local');
    const pm = new PullManager({ vault, drive, index, state });
    expect(await pm.refreshFile('n.md')).toBe('pulled');
    expect(writes).toContainEqual({ path: 'n.md', content: 'depuis drive' });
    expect(index.get('n.md')?.headRevisionId).toBe('r2');
    expect(index.get('n.md')?.syncedHash).toBe(hashContent('depuis drive'));
  });

  it('conflict si distant ET local ont changé → copie conflit, garde le local', async () => {
    const index = new MirrorIndex(ad()); await index.load(); await index.set('n.md', ENTRY({ headRevisionId: 'r1', syncedHash: hashContent('base') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const drive = driveObj();
    vi.spyOn(drive, 'getRevision').mockResolvedValue({ headRevisionId: 'r2' });
    vi.spyOn(drive, 'readText').mockResolvedValue('version distante');
    const updateText = vi.spyOn(drive, 'updateText').mockResolvedValue('r3');
    const { vault, writes } = vaultObj('edit local'); // local != base → édité
    const conflicts: string[] = [];
    const pm = new PullManager({ vault, drive, index, state, now: () => 'L', onConflict: (_p, cp) => conflicts.push(cp) });
    expect(await pm.refreshFile('n.md')).toBe('conflict');
    expect(writes).toContainEqual({ path: 'n (conflit L).md', content: 'version distante' });
    expect(conflicts).toEqual(['n (conflit L).md']);
    // le fichier local n'est PAS écrasé (aucune écriture vers 'n.md')
    expect(writes.some((w) => w.path === 'n.md')).toBe(false);
    expect(writes).toHaveLength(1);
    // le local est poussé sur Drive (last-write-wins), le distant reste dans la copie conflit
    expect(updateText).toHaveBeenCalledWith('D', 'edit local');
    // nouvelle baseline = local, révision issue du push adoptée
    expect(index.get('n.md')?.headRevisionId).toBe('r3');
    expect(index.get('n.md')?.syncedHash).toBe(hashContent('edit local'));
  });

  it('refreshAllSynced compte pulled et up-to-date', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('a.md', ENTRY({ driveId: 'DA', headRevisionId: 'r1', syncedHash: hashContent('same') }));
    await index.set('b.md', ENTRY({ driveId: 'DB', headRevisionId: 'r1', syncedHash: hashContent('same') }));
    const state = new SelectiveSyncState(ad()); await state.load();
    await state.setFileSynced('a.md', true); await state.setFileSynced('b.md', true);
    const drive = driveObj();
    vi.spyOn(drive, 'getRevision').mockImplementation(async (id: string) => (id === 'DB' ? { headRevisionId: 'r2' } : { headRevisionId: 'r1' }));
    vi.spyOn(drive, 'readText').mockResolvedValue('depuis drive');
    const { vault } = vaultObj('same'); // local == baseline → intact → b pull propre
    const pm = new PullManager({ vault, drive, index, state });
    const r = await pm.refreshAllSynced();
    expect(r).toEqual({ pulled: 1, conflicts: 0 }); // a up-to-date (r1==r1), b pulled (r2!=r1, local intact)
  });

  it('refreshFile retélécharge un fichier binaire via readBinary (jamais readText)', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('img.png', ENTRY({ mimeType: 'image/png', headRevisionId: 'r1' }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('img.png', true);
    const drive = driveObj();
    vi.spyOn(drive, 'getRevision').mockResolvedValue({ headRevisionId: 'r2' });
    const buf = new Uint8Array([9, 9]).buffer;
    vi.spyOn(drive, 'readBinary').mockResolvedValue(buf);
    const { vault } = vaultObj('n importe quoi');
    const readTextSpy = vi.spyOn(vault, 'readText');
    const writeBinarySpy = vi.spyOn(vault, 'writeBinary');
    const pm = new PullManager({ vault, drive, index, state });
    expect(await pm.refreshFile('img.png')).toBe('pulled');
    expect(readTextSpy).not.toHaveBeenCalled();
    expect(writeBinarySpy).toHaveBeenCalledWith('img.png', buf);
    expect(index.get('img.png')?.headRevisionId).toBe('r2');
  });

  it('refreshFile ne retélécharge/compare jamais une note-lien Google native', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('Doc.md', ENTRY({ mimeType: 'application/vnd.google-apps.document', headRevisionId: 'r1' }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('Doc.md', true);
    const drive = driveObj();
    const getRevisionSpy = vi.spyOn(drive, 'getRevision');
    const pm = new PullManager({ vault: vaultObj('x').vault, drive, index, state });
    expect(await pm.refreshFile('Doc.md')).toBe('up-to-date');
    expect(getRevisionSpy).not.toHaveBeenCalled();
  });
});
