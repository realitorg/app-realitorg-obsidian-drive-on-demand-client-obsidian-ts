import { describe, it, expect, vi } from 'vitest';
import { CreateManager } from './create-manager';
import { MirrorIndex, type MirrorEntry } from '../mirror/mirror-index';
import { SelectiveSyncState } from './selective-sync-state';
import { DriveClient } from '../drive/drive-client';
import type { VaultOps } from '../mirror/tree-mirror';
import type { PersistAdapter } from '../auth/token-store';
import type { HttpFn, HttpResponse } from '../http';

function ad() { const raw: Record<string, unknown> = {}; const a: PersistAdapter = { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } }; return a; }
function driveObj() {
  const http = vi.fn<HttpFn>(async () => ({ status: 200, text: '{}', json: <T>() => ({}) as T }));
  return new DriveClient(http, async () => 'AT');
}
function vaultObj(local = 'contenu') {
  const vault: VaultOps = { exists: async () => true, createFolder: async () => {}, createStub: async () => {}, writeText: async () => {}, writeBinary: async () => {}, readText: async () => local, readBinary: async () => new ArrayBuffer(0), remove: async () => {}, isEmptyFolder: () => false, rename: async () => {}, listChildren: () => [] };
  return vault;
}
const folderEntry = (driveId: string): MirrorEntry => ({ driveId, mimeType: 'application/vnd.google-apps.folder', isFolder: true, hydrated: true, pinned: true });

describe('CreateManager.handleCreate', () => {
  it('crée sur Drive un fichier créé sous un dossier synchronisé', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    const createFileSpy = vi.spyOn(drive, 'createFile').mockResolvedValue({ id: 'NEWFILE', headRevisionId: 'r1' });
    const cm = new CreateManager({ index, drive, vault: vaultObj('# hello'), state });
    expect(await cm.handleCreate('dir/note.md', false)).toBe('created');
    expect(createFileSpy).toHaveBeenCalledWith('DIR_DRIVE', 'note.md', '# hello');
    expect(index.get('dir/note.md')?.driveId).toBe('NEWFILE');
    expect(state.fileState('dir/note.md')).toBe('checked');
  });

  it('skip un fichier hors zone synchronisée', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj(); const spy = vi.spyOn(drive, 'createFile');
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.handleCreate('ailleurs/note.md', false)).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
  });

  it('skip ce que le plugin vient de créer (suppression)', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj(); const spy = vi.spyOn(drive, 'createFile');
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state, wasPluginCreated: (p) => p === 'dir/note.md' });
    expect(await cm.handleCreate('dir/note.md', false)).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
  });

  it('crée les dossiers Drive intermédiaires manquants', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    const createDriveFolderSpy = vi.spyOn(drive, 'createDriveFolder').mockResolvedValue({ id: 'SUB_DRIVE' });
    const createFileSpy = vi.spyOn(drive, 'createFile').mockResolvedValue({ id: 'NEWFILE', headRevisionId: 'r1' });
    const cm = new CreateManager({ index, drive, vault: vaultObj('x'), state });
    // 'dir/nuovo/note.md' : 'dir' est tracké, 'dir/nuovo' manquant
    expect(await cm.handleCreate('dir/nuovo/note.md', false)).toBe('created');
    expect(createDriveFolderSpy).toHaveBeenCalledWith('DIR_DRIVE', 'nuovo');
    expect(createFileSpy).toHaveBeenCalledWith('SUB_DRIVE', 'note.md', 'x');
    expect(index.get('dir/nuovo')?.driveId).toBe('SUB_DRIVE');
  });

  it('crée un DOSSIER sur Drive quand on crée un dossier sous une zone synchronisée', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    const createDriveFolderSpy = vi.spyOn(drive, 'createDriveFolder').mockResolvedValue({ id: 'NEWDIR' });
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.handleCreate('dir/nouveau', true)).toBe('created');
    expect(createDriveFolderSpy).toHaveBeenCalledWith('DIR_DRIVE', 'nouveau');
    expect(index.get('dir/nouveau')?.driveId).toBe('NEWDIR');
    expect(index.get('dir/nouveau')?.isFolder).toBe(true);
  });

  it('skip un chemin déjà indexé', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    await index.set('dir/note.md', { driveId: 'X', mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true });
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    const spy = vi.spyOn(drive, 'createFile');
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.handleCreate('dir/note.md', false)).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
  });

  it('crée un fichier BINAIRE sur Drive quand on crée une image sous une zone synchronisée', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const vault = vaultObj();
    vi.spyOn(vault, 'readBinary').mockResolvedValue(buf);
    const createBinaryFileSpy = vi.spyOn(drive, 'createBinaryFile').mockResolvedValue({ id: 'NEWIMG', headRevisionId: 'r1' });
    const cm = new CreateManager({ index, drive, vault, state });
    expect(await cm.handleCreate('dir/photo.png', false)).toBe('created');
    expect(createBinaryFileSpy).toHaveBeenCalledWith('DIR_DRIVE', 'photo.png', buf, 'image/png');
    expect(index.get('dir/photo.png')?.driveId).toBe('NEWIMG');
    expect(index.get('dir/photo.png')?.mimeType).toBe('image/png');
    expect(state.fileState('dir/photo.png')).toBe('checked');
  });

  it('réutilise un dossier Drive existant au lieu d en créer un doublon', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    vi.spyOn(drive, 'children').mockResolvedValue([{ id: 'EXISTING_SUB', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' }]);
    const createSpy = vi.spyOn(drive, 'createDriveFolder');
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.handleCreate('dir/sub', true)).toBe('created');
    expect(createSpy).not.toHaveBeenCalled();
    expect(index.get('dir/sub')?.driveId).toBe('EXISTING_SUB');
  });

  // ── Déplacement / renommage (handleRename) ──

  it('déplace un fichier NON suivi dans une zone synchronisée → le crée sur Drive', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    vi.spyOn(drive, 'children').mockResolvedValue([]);
    const createFileSpy = vi.spyOn(drive, 'createFile').mockResolvedValue({ id: 'NEW', headRevisionId: 'r1' });
    const move = vi.spyOn(drive, 'moveFile');
    const cm = new CreateManager({ index, drive, vault: vaultObj('# hi'), state });
    // le fichier existait ailleurs (non suivi) puis est déplacé dans dir/
    expect(await cm.handleRename('ailleurs/note.md', 'dir/note.md', false)).toBe('created');
    expect(createFileSpy).toHaveBeenCalledWith('DIR_DRIVE', 'note.md', '# hi');
    expect(move).not.toHaveBeenCalled(); // pas un déplacement Drive : c'est une création
    expect(index.get('dir/note.md')?.driveId).toBe('NEW');
    expect(state.fileState('dir/note.md')).toBe('checked');
  });

  it('déplace un fichier DÉJÀ suivi → moveFile sur Drive + réindexe les clés', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    await index.set('dir2', folderEntry('DIR2_DRIVE'));
    await index.set('dir/note.md', { driveId: 'FILE', mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true });
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('dir/note.md', true);
    const drive = driveObj();
    const move = vi.spyOn(drive, 'moveFile').mockResolvedValue(undefined);
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.handleRename('dir/note.md', 'dir2/note.md', false)).toBe('created');
    expect(move).toHaveBeenCalledWith('FILE', { name: 'note.md', addParentId: 'DIR2_DRIVE' });
    // clés déplacées
    expect(index.get('dir/note.md')).toBeUndefined();
    expect(index.get('dir2/note.md')?.driveId).toBe('FILE');
    expect(state.isSynced('dir/note.md')).toBe(false);
    expect(state.isSynced('dir2/note.md')).toBe(true);
  });

  it('déplace un fichier suivi HORS de toute zone synchronisée → cesse de suivre (reste sur Drive)', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    await index.set('dir/note.md', { driveId: 'FILE', mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true });
    const state = new SelectiveSyncState(ad()); await state.load(); await state.setFileSynced('dir/note.md', true);
    const drive = driveObj();
    const move = vi.spyOn(drive, 'moveFile');
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.handleRename('dir/note.md', 'hors-zone/note.md', false)).toBe('skipped');
    expect(move).not.toHaveBeenCalled();
    expect(index.get('dir/note.md')).toBeUndefined(); // plus suivi
    expect(state.isSynced('dir/note.md')).toBe(false);
  });

  // ── Téléversement d'un fichier « local-only » (uploadLocal) ──

  it('uploadLocal pousse un fichier local sous un parent Drive fourni, sans ancêtre suivi', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    vi.spyOn(drive, 'children').mockResolvedValue([]);
    const createFileSpy = vi.spyOn(drive, 'createFile').mockResolvedValue({ id: 'UP', headRevisionId: 'r1' });
    const cm = new CreateManager({ index, drive, vault: vaultObj('# contenu'), state });
    expect(await cm.uploadLocal('note.md', false, 'PARENT_ID')).toBe('created');
    expect(createFileSpy).toHaveBeenCalledWith('PARENT_ID', 'note.md', '# contenu');
    expect(index.get('note.md')?.driveId).toBe('UP');
    expect(state.fileState('note.md')).toBe('checked');
  });

  it('NFC : uploadLocal réutilise un dossier Drive en NFD au lieu d en créer un doublon', async () => {
    const base = 'datées';
    const index = new MirrorIndex(ad()); await index.load();
    await index.set('dir', folderEntry('DIR_DRIVE'));
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    vi.spyOn(drive, 'children').mockResolvedValue([{ id: 'EXISTING', name: base.normalize('NFD'), mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' }]);
    const createSpy = vi.spyOn(drive, 'createDriveFolder');
    const cm = new CreateManager({ index, drive, vault: vaultObj(), state });
    expect(await cm.uploadLocal(`dir/${base.normalize('NFC')}`, true, 'DIR_DRIVE')).toBe('created');
    expect(createSpy).not.toHaveBeenCalled(); // réutilise l'existant, pas de doublon
    expect(index.get(`dir/${base}`)?.driveId).toBe('EXISTING');
  });

  it('uploadLocal d un dossier téléverse récursivement son contenu local', async () => {
    const index = new MirrorIndex(ad()); await index.load();
    const state = new SelectiveSyncState(ad()); await state.load();
    const drive = driveObj();
    vi.spyOn(drive, 'children').mockResolvedValue([]);
    const createDriveFolderSpy = vi.spyOn(drive, 'createDriveFolder').mockResolvedValue({ id: 'FOLDER_DRIVE' });
    const createFileSpy = vi.spyOn(drive, 'createFile').mockResolvedValue({ id: 'F', headRevisionId: 'r1' });
    const vault = vaultObj('# c');
    vi.spyOn(vault, 'listChildren').mockImplementation((p) => (p === 'dossier' ? [{ name: 'enfant.md', isFolder: false }] : []));
    const cm = new CreateManager({ index, drive, vault, state });
    expect(await cm.uploadLocal('dossier', true, 'PARENT')).toBe('created');
    expect(createDriveFolderSpy).toHaveBeenCalledWith('PARENT', 'dossier');
    expect(createFileSpy).toHaveBeenCalledWith('FOLDER_DRIVE', 'enfant.md', '# c');
    expect(index.get('dossier')?.driveId).toBe('FOLDER_DRIVE');
    expect(index.get('dossier/enfant.md')?.driveId).toBe('F');
  });
});
