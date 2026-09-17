import { describe, it, expect, vi } from 'vitest';
import { PushManager, type PushManagerOptions } from './push-manager';
import { MirrorIndex, type MirrorEntry } from '../mirror/mirror-index';
import { SelectiveSyncState } from './selective-sync-state';
import { DriveClient } from '../drive/drive-client';
import type { VaultOps } from '../mirror/tree-mirror';
import type { PersistAdapter } from '../auth/token-store';
import type { HttpFn, HttpResponse } from '../http';
import { hashContent } from '../util/content-hash';

function ad() {
  const raw: Record<string, unknown> = {};
  const a: PersistAdapter = { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } };
  return a;
}
function vaultReturning(content: string): VaultOps {
  return { exists: async () => true, createFolder: async () => {}, createStub: async () => {}, writeText: async () => {}, writeBinary: async () => {}, readText: async () => content, readBinary: async () => new ArrayBuffer(0), remove: async () => {}, isEmptyFolder: () => false, rename: async () => {}, listChildren: () => [] };
}
function driveSpy() {
  const http = vi.fn<HttpFn>(async () => ({ status: 200, text: '{}', json: <T>() => ({}) as T }));
  const drive = new DriveClient(http, async () => 'AT');

  // Track updateText calls while preserving ability to mock with mockResolvedValue
  const updateTextSpy = vi.spyOn(drive, 'updateText');
  let calls: Array<{ id: string; content: string }> = [];

  // Set initial implementation that just returns undefined
  updateTextSpy.mockImplementation(async (id, content) => { calls.push({ id, content }); return 'r'; });

  // Wrap the mock so that even after mockResolvedValue, calls are tracked
  const originalMockResolvedValue = updateTextSpy.mockResolvedValue.bind(updateTextSpy);
  updateTextSpy.mockResolvedValue = (value: string | undefined) => {
    const result = originalMockResolvedValue(value);
    // After mockResolvedValue, re-wrap to track calls
    updateTextSpy.mockImplementation(async (id, content) => {
      calls.push({ id, content });
      return value;
    });
    return result;
  };

  vi.spyOn(drive, 'getRevision').mockResolvedValue({});
  return { drive, calls };
}
const ENTRY = (over: Partial<MirrorEntry> = {}): MirrorEntry => ({ driveId: 'D', mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true, ...over });

describe('PushManager', () => {
  it('push après debounce si contenu changé', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('n.md', ENTRY({ syncedHash: hashContent('ancien') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const { drive, calls } = driveSpy();
    const pm = new PushManager({ vault: vaultReturning('nouveau'), drive, index, state, debounceMs: 0 });
    pm.onModify('n.md');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([{ id: 'D', content: 'nouveau' }]);
    expect(index.get('n.md')?.syncedHash).toBe(hashContent('nouveau'));
  });

  it('ne push PAS si contenu inchangé (écriture d hydratation)', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('n.md', ENTRY({ syncedHash: hashContent('meme') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const { drive, calls } = driveSpy();
    const pm = new PushManager({ vault: vaultReturning('meme'), drive, index, state, debounceMs: 0 });
    pm.onModify('n.md');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([]);
  });

  it('ne push PAS un fichier non synchronisé', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    const state = new SelectiveSyncState(ad()); await state.load();
    const { drive, calls } = driveSpy();
    const pm = new PushManager({ vault: vaultReturning('x'), drive, index, state, debounceMs: 0 });
    pm.onModify('autre.md');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([]);
  });

  it('surfacer une erreur de push via onError (pas de rejet non géré)', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('n.md', ENTRY({ syncedHash: hashContent('old') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const { drive } = driveSpy();
    vi.spyOn(drive, 'updateText').mockRejectedValue(new Error('reseau'));
    const errors: Array<{ path: string; err: unknown }> = [];
    const pm = new PushManager({ vault: vaultReturning('nouveau'), drive, index, state, debounceMs: 0, onError: (path, err) => errors.push({ path, err }) });
    pm.onModify('n.md');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('n.md');
  });

  it('coalesce des modifies rapides en un seul push', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('n.md', ENTRY({ syncedHash: hashContent('v0') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);
    const { drive, calls } = driveSpy();
    let stored: (() => void) | null = null;
    const setT: PushManagerOptions['setTimeoutFn'] = ((fn) => { stored = fn; return 1; });
    const clearT: PushManagerOptions['clearTimeoutFn'] = (() => { stored = null; });
    const pm = new PushManager({ vault: vaultReturning('v2'), drive, index, state, debounceMs: 1000, setTimeoutFn: setT, clearTimeoutFn: clearT });
    pm.onModify('n.md');
    pm.onModify('n.md');
    stored!();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(1);
    expect(calls[0].content).toBe('v2');
  });

  it('au push, si la révision distante a changé → copie conflit + push local', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('n.md', ENTRY({ syncedHash: hashContent('base'), headRevisionId: 'r1' }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);

    const conflictWrites: Array<{ path: string; content: string }> = [];
    const vault: VaultOps = {
      exists: async () => true, createFolder: async () => {}, createStub: async () => {},
      writeText: async (p, d) => { conflictWrites.push({ path: p, content: d }); },
      writeBinary: async () => {}, readText: async () => 'edit local', readBinary: async () => new ArrayBuffer(0), remove: async () => {},
      isEmptyFolder: () => false, rename: async () => {}, listChildren: () => [],
    };
    const { drive, calls } = driveSpy();
    vi.spyOn(drive, 'getRevision').mockResolvedValue({ headRevisionId: 'r2' }); // distant a bougé
    vi.spyOn(drive, 'readText').mockResolvedValue('version distante');
    (drive.updateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('r3');
    const conflicts: string[] = [];
    const pm = new PushManager({ vault, drive, index, state, debounceMs: 0, now: () => 'L', onConflict: (p, cp) => conflicts.push(cp) });

    pm.onModify('n.md');
    await new Promise((r) => setTimeout(r, 10));
    // copie conflit écrite avec le contenu distant
    expect(conflictWrites).toContainEqual({ path: 'n (conflit L).md', content: 'version distante' });
    expect(conflicts).toEqual(['n (conflit L).md']);
    // push local quand même
    expect(calls).toEqual([{ id: 'D', content: 'edit local' }]);
    // révision mise à jour
    expect(index.get('n.md')?.headRevisionId).toBe('r3');
  });

  it('échec de push (hors-ligne) → inscrit au livret ; succès → retiré ; flushPending re-tente', async () => {
    const { OutboxStore } = await import('./outbox');
    const outbox = new OutboxStore(ad()); await outbox.load();
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('n.md', ENTRY({ syncedHash: hashContent('vieux') }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('n.md', true);

    // 1) hors-ligne : updateText échoue → inscrit au livret
    const { drive } = driveSpy();
    vi.spyOn(drive, 'updateText').mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    const pm = new PushManager({ vault: vaultReturning('nouveau'), drive, index, state, outbox, debounceMs: 0, onError: () => {} });
    await pm.flush('n.md').catch(() => {});
    expect(outbox.all()).toEqual(['n.md']);

    // 2) retour en ligne : flushPending re-pousse avec succès → retiré du livret
    (drive.updateText as unknown as ReturnType<typeof vi.fn>).mockReset();
    (drive.updateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('r9');
    await pm.flushPending();
    expect(outbox.all()).toEqual([]);
    expect(index.get('n.md')?.syncedHash).toBe(hashContent('nouveau'));
  });

  it('flush ne pousse jamais un fichier binaire (jamais de lecture texte)', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('img.png', ENTRY({ mimeType: 'image/png', syncedHash: undefined }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('img.png', true);
    const { drive } = driveSpy();
    const vault = vaultReturning('devrait ne jamais être lu');
    const readTextSpy = vi.spyOn(vault, 'readText');
    const pm = new PushManager({ vault, drive, index, state, debounceMs: 0 });
    await pm.flush('img.png');
    expect(readTextSpy).not.toHaveBeenCalled();
  });

  it('flush ne pousse jamais une note-lien Google native', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('Doc.md', ENTRY({ mimeType: 'application/vnd.google-apps.document' }));
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('Doc.md', true);
    const { drive } = driveSpy();
    const vault = vaultReturning('devrait ne jamais être lu');
    const readTextSpy = vi.spyOn(vault, 'readText');
    const pm = new PushManager({ vault, drive, index, state, debounceMs: 0 });
    await pm.flush('Doc.md');
    expect(readTextSpy).not.toHaveBeenCalled();
  });
});
