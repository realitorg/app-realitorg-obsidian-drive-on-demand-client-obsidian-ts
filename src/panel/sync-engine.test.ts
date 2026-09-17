// src/panel/sync-engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from './sync-engine';
import { MirrorIndex, type MirrorEntry } from '../mirror/mirror-index';
import { Hydrator } from '../mirror/hydrator';
import { SelectiveSyncState } from './selective-sync-state';
import { DriveClient } from '../drive/drive-client';
import { CancelToken } from '../util/cancel-token';
import type { VaultOps } from '../mirror/tree-mirror';
import type { PersistAdapter } from '../auth/token-store';
import type { TreeNode } from './tree-model';
import type { HttpFn, HttpResponse } from '../http';
import { setConfigDir } from '../mirror/tree-mirror';

// Dans Obsidian, le plugin lit ce dossier dans Vault#configDir au chargement.
setConfigDir('.obsidian');

function adapters() {
  const raw: Record<string, unknown> = {};
  const a: PersistAdapter = { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } };
  return a;
}
function fakeVault() {
  const files = new Set<string>();
  const folders = new Set<string>();
  const written: Record<string, string> = {};
  const vault: VaultOps = {
    exists: async (p) => files.has(p) || folders.has(p),
    createFolder: async (p) => { folders.add(p); },
    createStub: async (p) => { files.add(p); },
    writeText: async (p, d) => { files.add(p); written[p] = d; },
    writeBinary: async (p) => { files.add(p); },
    readText: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    remove: async (p) => { files.delete(p); folders.delete(p); },
    isEmptyFolder: (p) => folders.has(p) && ![...files, ...folders].some((x) => x.startsWith(p + '/')),
    rename: async () => {}, listChildren: () => [],
  };
  return { vault, files, folders, written };
}
function driveText(text: string, subtree: unknown[] = []): DriveClient {
  const http = vi.fn(async (req: { url: string }) => {
    if (req.url.includes('alt=media')) return { status: 200, text, json: <T>() => JSON.parse(text) as T };
    // Extract folder ID from the query URL to support recursive subtree queries
    const m = /%27([^%]+)%27%20in%20parents/.exec(req.url);
    const folderId = m ? m[1] : 'root';
    // Only return subtree for the root folder being queried; empty for nested folders
    const data = folderId === 'dir-id' ? subtree : [];
    return { status: 200, text: JSON.stringify({ files: data }), json: <T>() => JSON.parse(JSON.stringify({ files: data })) as T };
  }) as unknown as HttpFn;
  return new DriveClient(http, async () => 'AT');
}
const node = (path: string, isFolder = false, id = `id:${path}`): TreeNode => ({
  id, name: path.split('/').pop()!, path, isFolder,
  meta: { id, name: path.split('/').pop()!, mimeType: isFolder ? 'application/vnd.google-apps.folder' : 'text/markdown', modifiedTime: 't', headRevisionId: 'r' },
});

describe('SyncEngine', () => {
  it('syncFile matérialise + hydrate + marque synchronisé', async () => {
    const { vault, folders, written } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('# c'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('# c'), state);

    await eng.syncFile(node('a/b.md'));
    expect(folders.has('a')).toBe(true);
    expect(written['a/b.md']).toBe('# c');
    expect(state.fileState('a/b.md')).toBe('checked');
  });

  it('syncFile respecte un token déjà annulé', async () => {
    const { vault } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('# c'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('# c'), state);
    const token = new CancelToken();
    token.cancel();
    await expect(eng.syncFile(node('a/b.md'), token)).rejects.toThrow('Annulé');
    expect(state.fileState('a/b.md')).toBe('unchecked');
  });

  it('unsyncFile retire du vault et démarque', async () => {
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('x'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('x'), state);
    await eng.syncFile(node('n.md'));
    await eng.unsyncFile('n.md');
    expect(files.has('n.md')).toBe(false);
    expect(state.fileState('n.md')).toBe('unchecked');
  });

  it('applyFolderSync matérialise tout le sous-arbre et marque le dossier plein', async () => {
    const subtree = [
      { id: 'd', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' },
      { id: 'f1', name: 'x.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, written } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);

    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);
    await eng.applyFolderSync(dirNode, plan);
    expect(state.folderState('dir')).toBe('checked');
    expect(state.fileState('dir/x.md')).toBe('checked');
    expect(written['dir/x.md']).toBe('# data');
  });

  it('applyFolderSync notifie onFileDone après CHAQUE fichier (pas seulement à la fin)', async () => {
    const subtree = [
      { id: 'f1', name: 'a.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'f2', name: 'b.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'f3', name: 'c.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);

    const doneOrder: string[] = [];
    // à chaque callback, l'état DOIT déjà refléter ce fichier comme synchronisé —
    // sinon l'UI ferait disparaître le spinner avant que la checkbox soit vraiment cochée
    const checkedAtCallTime: boolean[] = [];
    await eng.applyFolderSync(dirNode, plan, undefined, (path) => {
      doneOrder.push(path);
      checkedAtCallTime.push(state.fileState(path) === 'checked');
    });
    expect(doneOrder).toEqual(['dir/a.md', 'dir/b.md', 'dir/c.md']);
    expect(checkedAtCallTime).toEqual([true, true, true]);
  });

  it('applyFolderSync sans onFileDone fonctionne comme avant (paramètre optionnel)', async () => {
    const subtree = [{ id: 'f1', name: 'x.md', mimeType: 'text/markdown', modifiedTime: 't' }];
    const { vault } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    const result = await eng.applyFolderSync(dirNode, await eng.planFolderSync(dirNode));
    expect(result.failed).toEqual([]);
  });

  it('unsyncFolder retire tout le sous-arbre et remet l état à zéro', async () => {
    const subtree = [
      { id: 'd', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' },
      { id: 'f1', name: 'x.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    await eng.applyFolderSync(dirNode, await eng.planFolderSync(dirNode));
    expect(state.folderState('dir')).toBe('checked');
    await eng.unsyncFolder(dirNode);
    expect(state.folderState('dir')).toBe('unchecked');
    expect(state.syncedUnder('dir')).toEqual([]);
    expect(files.has('dir/x.md')).toBe(false);
  });

  it('unsyncAll retire tous les fichiers synchronisés et vide état + index (changement de dossier de travail)', async () => {
    const subtree = [
      { id: 'd', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' },
      { id: 'f1', name: 'x.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    await eng.applyFolderSync(node('dir', true, 'dir-id'), await eng.planFolderSync(node('dir', true, 'dir-id')));
    expect(state.allSynced().length).toBeGreaterThan(0);
    expect(index.paths().length).toBeGreaterThan(0);

    await eng.unsyncAll();

    expect(state.allSynced()).toEqual([]);
    expect(state.allFullFolders()).toEqual([]);
    expect(index.paths()).toEqual([]);
    expect(files.has('dir/x.md')).toBe(false);
  });

  it('syncFile n écrase jamais un fichier préexistant (data-safety)', async () => {
    const { vault, files, written } = fakeVault();
    files.add('perso.md'); // fichier utilisateur déjà présent
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('DEPUIS DRIVE'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('DEPUIS DRIVE'), state);
    await eng.syncFile(node('perso.md'));
    expect(written['perso.md']).toBeUndefined(); // contenu Drive PAS écrit par-dessus
  });

  it('unsyncFile prune les dossiers parents devenus vides', async () => {
    const { vault, files, folders } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('# c'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('# c'), state);
    await eng.syncFile(node('a/b/c.md'));
    await eng.unsyncFile('a/b/c.md');
    expect(files.has('a/b/c.md')).toBe(false);
    expect(folders.has('a/b')).toBe(false);
    expect(folders.has('a')).toBe(false);
  });

  it('unsyncFile garde un dossier parent non vide', async () => {
    const { vault, folders } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('# c'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('# c'), state);
    await eng.syncFile(node('a/b/c.md'));
    await eng.syncFile(node('a/b/d.md'));
    await eng.unsyncFile('a/b/c.md');
    expect(folders.has('a/b')).toBe(true); // d.md est encore là
  });

  it('unsyncFolder ne supprime jamais un fichier utilisateur non suivi (data-safety)', async () => {
    const { vault, files, folders } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('# c'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('# c'), state);
    await eng.syncFile(node('A/B/c.md'));
    files.add('A/user.md'); // fichier utilisateur jamais synchronisé par le plugin
    await eng.unsyncFolder(node('A', true));
    expect(files.has('A/user.md')).toBe(true); // préservé
    expect(files.has('A/B/c.md')).toBe(false); // fichier suivi supprimé
    expect(folders.has('A/B')).toBe(false); // sous-dossier devenu vide, prune
    expect(folders.has('A')).toBe(true); // gardé car user.md y reste
  });

  it('applyFolderSync inclut désormais les fichiers binaires (plus exclus)', async () => {
    const subtree = [
      { id: 'f1', name: 'x.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'f2', name: 'pic.png', mimeType: 'image/png', modifiedTime: 't' },
    ];
    const { vault, files, written } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const mockBuffer = new Uint8Array([1]).buffer;
    vi.spyOn(drive, 'readBinary').mockResolvedValue(mockBuffer);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);

    const writeBinarySpy = vi.spyOn(vault, 'writeBinary');
    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);
    await eng.applyFolderSync(dirNode, plan);
    expect(written['dir/x.md']).toBe('# data');
    expect(state.fileState('dir/x.md')).toBe('checked');
    // les fichiers binaires (non Google-natifs) sont désormais matérialisés eux aussi
    expect(files.has('dir/pic.png')).toBe(true);
    expect(state.fileState('dir/pic.png')).toBe('checked');
    expect(index.get('dir/pic.png')).toBeDefined();
    // vérifier que writeBinary a été appelé avec le buffer exact
    expect(writeBinarySpy).toHaveBeenCalledWith('dir/pic.png', mockBuffer);
    // vérifier que le mimeType est correctement stocké dans l index
    expect(index.get('dir/pic.png')?.mimeType).toBe('image/png');
  });

  it('applyFolderSync indexe les dossiers avec leur driveId', async () => {
    const subtree = [
      { id: 'dsub', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' },
      { id: 'f1', name: 'x.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    await eng.applyFolderSync(dirNode, await eng.planFolderSync(dirNode));
    expect(index.get('dir')?.driveId).toBe('dir-id');
    expect(index.get('dir')?.isFolder).toBe(true);
    expect(index.get('dir/sub')?.driveId).toBe('dsub');
  });

  it('applyFolderSync annulé en cours de route : les fichiers créés pendant cette tentative sont défaits', async () => {
    const subtree = [
      { id: 'f1', name: 'a.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'f2', name: 'b.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);
    const token = new CancelToken();
    // annule dès que le premier fichier est indexé (juste avant le 2e tour de boucle)
    const originalSet = index.set.bind(index);
    vi.spyOn(index, 'set').mockImplementation(async (p: string, e: MirrorEntry) => {
      const r = await originalSet(p, e);
      if (p === 'dir/a.md') token.cancel();
      return r;
    });
    await expect(eng.applyFolderSync(dirNode, plan, token)).rejects.toThrow('Annulé');
    // a.md a été matérialisé PENDANT cette tentative : annulation = défait (rollback)
    expect(state.fileState('dir/a.md')).toBe('unchecked');
    expect(files.has('dir/a.md')).toBe(false);
    // b.md n a jamais été traité
    expect(state.fileState('dir/b.md')).toBe('unchecked');
  });

  it('annulation : ne défait PAS un fichier déjà synchronisé d une exécution précédente', async () => {
    const subtree = [
      { id: 'f1', name: 'a.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'f2', name: 'b.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);
    // a.md est déjà présent/synchronisé d'une tentative précédente
    await eng.syncFile({ ...node('dir/a.md'), id: 'f1' });
    expect(state.fileState('dir/a.md')).toBe('checked');
    // 2e tentative : annulée juste après avoir matérialisé b.md (nouveau cette fois)
    const token = new CancelToken();
    const originalSet = index.set.bind(index);
    vi.spyOn(index, 'set').mockImplementation(async (p: string, e: MirrorEntry) => {
      const r = await originalSet(p, e);
      if (p === 'dir/b.md') token.cancel();
      return r;
    });
    await expect(eng.applyFolderSync(dirNode, plan, token)).rejects.toThrow('Annulé');
    // a.md (préexistant) doit rester synchronisé — jamais touché par le rollback
    expect(state.fileState('dir/a.md')).toBe('checked');
    expect(files.has('dir/a.md')).toBe(true);  // préexistant : jamais touché sur le disque
    // b.md (nouveau cette exécution) doit être défait
    expect(state.fileState('dir/b.md')).toBe('unchecked');
    expect(files.has('dir/b.md')).toBe(false); // créé cette exécution : bien retiré du disque
  });

  it('unsyncFolder annulé en cours de route : les fichiers déjà retirés restent démarqués, les autres restent synchronisés', async () => {
    const subtree = [
      { id: 'f1', name: 'a.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'f2', name: 'b.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# data', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    await eng.applyFolderSync(dirNode, await eng.planFolderSync(dirNode));
    expect(state.fileState('dir/a.md')).toBe('checked');
    expect(state.fileState('dir/b.md')).toBe('checked');

    const token = new CancelToken();
    // annule dès que le premier fichier est retiré du vault
    const originalRemove = vault.remove.bind(vault);
    vi.spyOn(vault, 'remove').mockImplementation(async (p: string) => {
      await originalRemove(p);
      if (p === 'dir/a.md') token.cancel();
    });
    await expect(eng.unsyncFolder(dirNode, token)).rejects.toThrow('Annulé');
    // a.md a été physiquement supprimé ET démarqué malgré l'annulation
    expect(files.has('dir/a.md')).toBe(false);
    expect(state.fileState('dir/a.md')).toBe('unchecked');
    // b.md n a jamais été traité : toujours présent et toujours marqué synchronisé
    expect(files.has('dir/b.md')).toBe(true);
    expect(state.fileState('dir/b.md')).toBe('checked');
  });

  it('unsyncFolder retire un dossier resté vide (aucun fichier synchronisé dedans)', async () => {
    const { vault, folders } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('x'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('x'), state);
    // simule un dossier vide coché : créé par applyFolderSync avec un subtree vide
    const dirNode = node('dir-vide', true, 'dir-id');
    await eng.applyFolderSync(dirNode, []);
    expect(folders.has('dir-vide')).toBe(true);
    await eng.unsyncFolder(dirNode);
    expect(folders.has('dir-vide')).toBe(false);
    expect(state.folderState('dir-vide')).toBe('unchecked');
  });

  it('unsyncFolder garde un dossier qui contient encore un fichier utilisateur non suivi', async () => {
    const { vault, files, folders } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('x'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('x'), state);
    const dirNode = node('dir', true, 'dir-id');
    await eng.syncFile(node('dir/synced.md', false, 'f1'));
    files.add('dir/perso.md'); // fichier utilisateur jamais synchronisé par le plugin
    await eng.unsyncFolder(dirNode);
    expect(files.has('dir/synced.md')).toBe(false); // retiré (était synchronisé)
    expect(files.has('dir/perso.md')).toBe(true);    // préservé (jamais suivi)
    expect(folders.has('dir')).toBe(true);            // dossier gardé car pas vide
  });

  it('applyFolderSync isole une erreur sur un fichier : les autres se synchronisent quand même', async () => {
    const subtree = [
      { id: 'BAD', name: 'casse.md', mimeType: 'text/markdown', modifiedTime: 't' },
      { id: 'GOOD', name: 'ok.md', mimeType: 'text/markdown', modifiedTime: 't' },
    ];
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const drive = driveText('# contenu', subtree);
    vi.spyOn(drive, 'readText').mockImplementation(async (id: string) => {
      if (id === 'BAD') throw new Error('boom réseau');
      return '# contenu';
    });
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);
    const result = await eng.applyFolderSync(dirNode, plan);
    expect(result.failed).toEqual(['dir/casse.md']);
    expect(files.has('dir/ok.md')).toBe(true);
    expect(state.fileState('dir/ok.md')).toBe('checked');
    // le fichier en échec n est PAS marqué synchronisé
    expect(state.fileState('dir/casse.md')).toBe('unchecked');
    // le dossier reste partiel (pas "complet") puisque tout n a pas réussi
    expect(state.folderState('dir')).toBe('partial');
  });

  it('applyFolderSync sur le dossier du plugin lui-même est un no-op complet', async () => {
    const { vault, folders } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('x'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('x'), state);
    const selfNode = node('.obsidian/plugins/google-drive-fod', true, 'self-id');
    await eng.applyFolderSync(selfNode, []);
    expect(folders.has('.obsidian/plugins/google-drive-fod')).toBe(false);
    expect(state.folderState('.obsidian/plugins/google-drive-fod')).toBe('unchecked');
  });

  it('syncFile sur un Google Doc crée une note-lien .md (jamais de contenu brut)', async () => {
    const { vault, files, written } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('x'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('x'), state);
    const docNode = {
      ...node('Mon Rapport', false, 'doc-id'),
      meta: { id: 'doc-id', name: 'Mon Rapport', mimeType: 'application/vnd.google-apps.document', modifiedTime: 't' },
    };
    await eng.syncFile(docNode);
    // suffixe .md requis pour qu'Obsidian reconnaisse le fichier comme note éditable
    expect(files.has('Mon Rapport')).toBe(false);
    expect(files.has('Mon Rapport.md')).toBe(true);
    expect(state.fileState('Mon Rapport.md')).toBe('checked');
    expect(index.get('Mon Rapport.md')?.mimeType).toBe('application/vnd.google-apps.document');
    expect(index.get('Mon Rapport.md')?.hydrated).toBe(true);
    expect(written['Mon Rapport.md']).toContain('https://docs.google.com/document/d/doc-id/edit');
  });

  it('applyFolderSync inclut les Google Docs sous forme de notes-liens .md', async () => {
    const { vault, files, written } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const subtree = [{ id: 'doc-id', name: 'Notes réunion', mimeType: 'application/vnd.google-apps.document', modifiedTime: 't' }];
    const drive = driveText('# texte', subtree);
    const hydrator = new Hydrator(vault, index, drive);
    const eng = new SyncEngine(vault, index, hydrator, drive, state);
    const dirNode = node('dir', true, 'dir-id');
    const plan = await eng.planFolderSync(dirNode);
    const result = await eng.applyFolderSync(dirNode, plan);
    expect(result.failed).toEqual([]);
    expect(files.has('dir/Notes réunion')).toBe(false);
    expect(files.has('dir/Notes réunion.md')).toBe(true);
    expect(state.fileState('dir/Notes réunion.md')).toBe('checked');
    expect(written['dir/Notes réunion.md']).toContain('https://docs.google.com/document/d/doc-id/edit');
  });

  it('unsyncFile sur un Google Doc synchronisé retire la note-lien .md', async () => {
    const { vault, files } = fakeVault();
    const index = new MirrorIndex(adapters()); await index.load();
    const state = new SelectiveSyncState(adapters()); await state.load();
    const hydrator = new Hydrator(vault, index, driveText('x'));
    const eng = new SyncEngine(vault, index, hydrator, driveText('x'), state);
    const docNode = {
      ...node('Mon Rapport', false, 'doc-id'),
      meta: { id: 'doc-id', name: 'Mon Rapport', mimeType: 'application/vnd.google-apps.document', modifiedTime: 't' },
    };
    await eng.syncFile(docNode);
    await eng.unsyncFile('Mon Rapport.md');
    expect(files.has('Mon Rapport.md')).toBe(false);
    expect(state.fileState('Mon Rapport.md')).toBe('unchecked');
  });
});
