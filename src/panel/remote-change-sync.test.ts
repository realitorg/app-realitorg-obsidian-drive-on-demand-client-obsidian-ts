import { describe, it, expect, vi } from 'vitest';
import { RemoteChangeSync, type RemoteChangeSyncOptions } from './remote-change-sync';
import { MirrorIndex, type MirrorEntry } from '../mirror/mirror-index';
import { SelectiveSyncState } from './selective-sync-state';
import type { PersistAdapter } from '../auth/token-store';

function ad() {
  const raw: Record<string, unknown> = {};
  const a: PersistAdapter = { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } };
  return { a, raw };
}
const fileEntry = (driveId: string): MirrorEntry => ({ driveId, mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true });
const folderEntry = (driveId: string): MirrorEntry => ({ driveId, mimeType: 'application/vnd.google-apps.folder', isFolder: true, hydrated: true, pinned: true });

type Change = { fileId: string; removed: boolean; name?: string; parents?: string[] };
function makeDrive(changes: Change[], rootId = 'REALROOT') {
  return {
    getStartPageToken: vi.fn(async () => 'START'),
    getRootFolderId: vi.fn(async () => rootId),
    listChanges: vi.fn(async () => ({ changes, newStartPageToken: 'NEXT' })),
  };
}

async function setup(
  changes: Change[],
  seed: (i: MirrorIndex, s: SelectiveSyncState) => Promise<void>,
  token = 'CUR',
  extra: Partial<RemoteChangeSyncOptions> = {},
) {
  const index = new MirrorIndex(ad().a); await index.load();
  const state = new SelectiveSyncState(ad().a); await state.load();
  await seed(index, state);
  const vault = { rename: vi.fn(async () => {}), trashToVault: vi.fn(async () => {}) };
  const pull = { refreshFile: vi.fn(async () => 'pulled') };
  const resyncFullFolder = vi.fn(async () => {});
  const onRemoteChanges = vi.fn();
  const { a, raw } = ad();
  raw.changesToken = token;
  const drive = makeDrive(changes);
  const opts: RemoteChangeSyncOptions = {
    drive, index, state, vault, pull, rootId: () => 'root', adapter: a, resyncFullFolder, onRemoteChanges, ...extra,
  };
  const rcs = new RemoteChangeSync(opts);
  await rcs.load();
  return { rcs, index, state, vault, pull, drive, raw, resyncFullFolder, onRemoteChanges };
}

describe('RemoteChangeSync', () => {
  it('changements Drive, même non suivis → le panneau est prévenu ; aucun changement → rien', async () => {
    const withChanges = await setup([{ fileId: 'INCONNU', removed: false, name: 'x.md', parents: ['AILLEURS'] }], async () => {});
    await withChanges.rcs.scan();
    expect(withChanges.onRemoteChanges).toHaveBeenCalledTimes(1);
    const without = await setup([], async () => {});
    await without.rcs.scan();
    expect(without.onRemoteChanges).not.toHaveBeenCalled();
  });

  it('premier passage (sans jeton) : établit le point de référence, ne touche à rien', async () => {
    const index = new MirrorIndex(ad().a); await index.load();
    const state = new SelectiveSyncState(ad().a); await state.load();
    const vault = { rename: vi.fn(async () => {}), trashToVault: vi.fn(async () => {}) };
    const pull = { refreshFile: vi.fn(async () => 'x') };
    const { a, raw } = ad();
    const drive = makeDrive([]);
    const rcs = new RemoteChangeSync({ drive, index, state, vault, pull, rootId: () => 'root', adapter: a });
    await rcs.load();
    await rcs.scan();
    expect(drive.getStartPageToken).toHaveBeenCalledTimes(1);
    expect(drive.listChanges).not.toHaveBeenCalled();
    expect(raw.changesToken).toBe('START');
  });

  it('renommage sur Drive (même dossier suivi) → renomme en local + réindexe + tire le contenu', async () => {
    const { rcs, index, state, vault, pull, raw } = await setup(
      [{ fileId: 'FILE', removed: false, name: 'nouveau.md', parents: ['DIR'] }],
      async (i, s) => { await i.set('dir', folderEntry('DIR')); await i.set('dir/ancien.md', fileEntry('FILE')); await s.setFileSynced('dir/ancien.md', true); },
    );
    await rcs.scan();
    expect(vault.rename).toHaveBeenCalledWith('dir/ancien.md', 'dir/nouveau.md');
    expect(index.get('dir/ancien.md')).toBeUndefined();
    expect(index.get('dir/nouveau.md')?.driveId).toBe('FILE');
    expect(state.isSynced('dir/nouveau.md')).toBe(true);
    expect(pull.refreshFile).toHaveBeenCalledWith('dir/nouveau.md');
    expect(raw.changesToken).toBe('NEXT');
  });

  it('renommage à la RACINE (parent = id racine réel) → utilise getRootFolderId', async () => {
    const { rcs, vault, index } = await setup(
      [{ fileId: 'FILE', removed: false, name: 'renommee.md', parents: ['REALROOT'] }],
      async (i, s) => { await i.set('note.md', fileEntry('FILE')); await s.setFileSynced('note.md', true); },
    );
    await rcs.scan();
    expect(vault.rename).toHaveBeenCalledWith('note.md', 'renommee.md');
    expect(index.get('renommee.md')?.driveId).toBe('FILE');
  });

  it('contenu modifié (même nom/dossier) → pas de renommage, tire le contenu', async () => {
    const { rcs, vault, pull } = await setup(
      [{ fileId: 'FILE', removed: false, name: 'note.md', parents: ['DIR'] }],
      async (i, s) => { await i.set('dir', folderEntry('DIR')); await i.set('dir/note.md', fileEntry('FILE')); await s.setFileSynced('dir/note.md', true); },
    );
    await rcs.scan();
    expect(vault.rename).not.toHaveBeenCalled();
    expect(pull.refreshFile).toHaveBeenCalledWith('dir/note.md');
  });

  it('suppression distante → .trash du vault, plus suivi, ni renommage ni tir', async () => {
    const { rcs, vault, pull, index, state } = await setup(
      [{ fileId: 'FILE', removed: true }],
      async (i, s) => { await i.set('dir/note.md', fileEntry('FILE')); await s.setFileSynced('dir/note.md', true); },
    );
    await rcs.scan();
    expect(vault.trashToVault).toHaveBeenCalledWith('dir/note.md');
    expect(vault.rename).not.toHaveBeenCalled();
    expect(pull.refreshFile).not.toHaveBeenCalled();
    expect(index.get('dir/note.md')).toBeUndefined();
    expect(state.isSynced('dir/note.md')).toBe(false);
  });

  it('suppression distante d un fichier aux modifs locales non envoyées → gardé en local, plus suivi', async () => {
    const { rcs, vault, index } = await setup(
      [{ fileId: 'FILE', removed: true }],
      async (i, s) => { await i.set('dir/note.md', fileEntry('FILE')); await s.setFileSynced('dir/note.md', true); },
      'CUR',
      { hasPendingPush: (p) => p === 'dir/note.md' },
    );
    await rcs.scan();
    expect(vault.trashToVault).not.toHaveBeenCalled();
    expect(index.get('dir/note.md')).toBeUndefined();
  });

  it('dossier supprimé sur Drive avec son contenu → un seul envoi au .trash (le dossier)', async () => {
    const { rcs, vault, index, state } = await setup(
      [{ fileId: 'DIR', removed: true }, { fileId: 'FILE', removed: true }],
      async (i, s) => {
        await i.set('dir', folderEntry('DIR')); await i.set('dir/note.md', fileEntry('FILE'));
        await s.setFolderFull('dir', ['dir/note.md'], [], true);
      },
    );
    await rcs.scan();
    expect(vault.trashToVault).toHaveBeenCalledTimes(1);
    expect(vault.trashToVault).toHaveBeenCalledWith('dir');
    expect(index.paths()).toEqual([]);
    expect(state.folderState('dir')).toBe('unchecked');
  });

  it('plus de 10 suppressions distantes → rien en local sans confirmation', async () => {
    const ids = Array.from({ length: 11 }, (_, k) => `F${k}`);
    const seed = async (i: MirrorIndex, s: SelectiveSyncState) => {
      for (const id of ids) { await i.set(`n${id}.md`, fileEntry(id)); await s.setFileSynced(`n${id}.md`, true); }
    };
    const changes = ids.map((id) => ({ fileId: id, removed: true }));
    const refused = await setup(changes, seed, 'CUR', { confirmMassDelete: async () => false });
    await refused.rcs.scan();
    expect(refused.vault.trashToVault).not.toHaveBeenCalled();
    expect(refused.index.paths()).toEqual([]); // plus suivis : fichiers locaux gardés, grisés
    const noPrompt = await setup(changes, seed);
    await noPrompt.rcs.scan();
    expect(noPrompt.vault.trashToVault).not.toHaveBeenCalled();
    const accepted = await setup(changes, seed, 'CUR', { confirmMassDelete: async (n) => n === 11 });
    await accepted.rcs.scan();
    expect(accepted.vault.trashToVault).toHaveBeenCalledTimes(11);
  });

  it('changement d un fichier NON suivi dont le parent N EST PAS full-sync → ignoré (pas de download auto)', async () => {
    const { rcs, vault, pull, resyncFullFolder } = await setup(
      [{ fileId: 'INCONNU', removed: false, name: 'x.md', parents: ['DIR'] }],
      async (i) => { await i.set('dir', folderEntry('DIR')); }, // dossier indexé mais PAS marqué full
    );
    await rcs.scan();
    expect(vault.rename).not.toHaveBeenCalled();
    expect(pull.refreshFile).not.toHaveBeenCalled();
    expect(resyncFullFolder).not.toHaveBeenCalled();
  });

  it('NOUVEAU fichier dont le parent EST un dossier full-sync → re-sync du dossier parent', async () => {
    const { rcs, resyncFullFolder } = await setup(
      [{ fileId: 'NEW', removed: false, name: 'nouvelle.md', parents: ['DIR'] }],
      async (i, s) => {
        await i.set('dir', folderEntry('DIR'));
        await s.setFolderFull('dir', [], [], true); // dossier synchronisé EN ENTIER
      },
    );
    await rcs.scan();
    expect(resyncFullFolder).toHaveBeenCalledWith('dir');
    expect(resyncFullFolder).toHaveBeenCalledTimes(1);
  });

  it('plusieurs nouveaux fichiers dans le MÊME dossier full → un seul re-sync (dédup)', async () => {
    const { rcs, resyncFullFolder } = await setup(
      [
        { fileId: 'N1', removed: false, name: 'a.md', parents: ['DIR'] },
        { fileId: 'N2', removed: false, name: 'b.md', parents: ['DIR'] },
      ],
      async (i, s) => { await i.set('dir', folderEntry('DIR')); await s.setFolderFull('dir', [], [], true); },
    );
    await rcs.scan();
    expect(resyncFullFolder).toHaveBeenCalledTimes(1);
    expect(resyncFullFolder).toHaveBeenCalledWith('dir');
  });

  it('nouveau fichier à la RACINE full → re-sync racine (parent = id racine réel)', async () => {
    const { rcs, resyncFullFolder } = await setup(
      [{ fileId: 'NEW', removed: false, name: 'note.md', parents: ['REALROOT'] }],
      async (i, s) => { await s.setFolderFull('', [], [], true); },
    );
    await rcs.scan();
    expect(resyncFullFolder).toHaveBeenCalledWith('');
  });
});
