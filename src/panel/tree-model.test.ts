import { describe, it, expect, vi, type Mock } from 'vitest';
import { DriveTreeModel } from './tree-model';
import { DriveClient } from '../drive/drive-client';
import type { HttpFn, HttpResponse } from '../http';
import type { PersistAdapter } from '../auth/token-store';
import { setConfigDir } from '../mirror/tree-mirror';

// Dans Obsidian, le plugin lit ce dossier dans Vault#configDir au chargement.
setConfigDir('.obsidian');

function memAdapter() {
  const raw: Record<string, unknown> = {};
  const a: PersistAdapter = {
    async load() { return raw; },
    async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); },
  };
  return { a, raw };
}
/** Drive dont le http lève (simule le hors-ligne / injoignable). */
function driveOffline(kind: 'network' | 'auth' = 'network'): DriveClient {
  const http = vi.fn<HttpFn>(async () => {
    throw new Error(kind === 'auth' ? 'NEED_INTERACTIVE_AUTH' : 'net::ERR_INTERNET_DISCONNECTED');
  });
  return new DriveClient(http, async () => 'AT');
}

function res(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return { status, text, json: <T>() => JSON.parse(text) as T };
}
function driveWith(byFolder: Record<string, unknown[]>): { drive: DriveClient; http: Mock<HttpFn> } {
  const http = vi.fn<HttpFn>(async (req) => {
    const m = /%27([^%]+)%27%20in%20parents/.exec(req.url);
    const fid = m ? m[1] : 'root';
    return res(200, { files: byFolder[fid] ?? [] });
  });
  return { drive: new DriveClient(http, async () => 'AT'), http };
}
const folder = (id: string, name: string) => ({ id, name, mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' });
const file = (id: string, name: string) => ({ id, name, mimeType: 'text/markdown', modifiedTime: 't' });

describe('DriveTreeModel', () => {
  it('cachedChildren : enfants du cache sans appel Drive, undefined si jamais listé', async () => {
    const { drive, http } = driveWith({ root: [folder('A', 'Docs'), file('f1', 'a.md')] });
    const m = new DriveTreeModel(drive);
    expect(m.cachedChildren('root', '')).toBeUndefined();
    await m.loadChildren('root', '');
    const calls = http.mock.calls.length;
    expect(m.cachedChildren('root', '')?.map((n) => n.path)).toEqual(['Docs', 'a.md']);
    expect(http.mock.calls.length).toBe(calls);
  });

  it('charge les enfants de la racine, dossiers avant fichiers, triés alpha', async () => {
    const { drive } = driveWith({ root: [file('f1', 'zeta.md'), folder('d1', 'Beta'), file('f2', 'alpha.md')] });
    const model = new DriveTreeModel(drive);
    const nodes = await model.loadChildren('root', '');
    expect(nodes.map((n) => n.name)).toEqual(['Beta', 'alpha.md', 'zeta.md']);
    expect(nodes[0].isFolder).toBe(true);
    expect(nodes[0].path).toBe('Beta');
  });

  it('calcule les chemins relatifs à partir du parent', async () => {
    const { drive } = driveWith({ d1: [file('f1', 'note.md')] });
    const model = new DriveTreeModel(drive);
    const nodes = await model.loadChildren('d1', 'cycles');
    expect(nodes[0].path).toBe('cycles/note.md');
  });

  it('met en cache : 2e loadChildren ne refetch pas', async () => {
    const { drive, http } = driveWith({ root: [file('f1', 'a.md')] });
    const model = new DriveTreeModel(drive);
    await model.loadChildren('root', '');
    await model.loadChildren('root', '');
    expect(http).toHaveBeenCalledTimes(1);
    model.invalidate('root');
    await model.loadChildren('root', '');
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('invalidateAll refetch aussi les SOUS-dossiers (renommage fait sur Drive)', async () => {
    const byFolder: Record<string, unknown[]> = { root: [folder('d1', 'Dossier')], d1: [file('f1', 'ancien.md')] };
    const { drive, http } = driveWith(byFolder);
    const model = new DriveTreeModel(drive);
    await model.loadChildren('root', '');
    expect((await model.loadChildren('d1', 'Dossier'))[0].name).toBe('ancien.md');

    byFolder.d1 = [file('f1', 'nouveau.md')]; // renommé côté Drive
    model.invalidate('root'); // l'ancien comportement : racine seule → sous-dossier figé
    await model.loadChildren('root', '');
    expect((await model.loadChildren('d1', 'Dossier'))[0].name).toBe('ancien.md');

    model.invalidateAll();
    await model.loadChildren('root', '');
    expect((await model.loadChildren('d1', 'Dossier'))[0].name).toBe('nouveau.md');
    expect(http).toHaveBeenCalled();
  });

  it('toggle / isExpanded suivent l état déplié', () => {
    const { drive } = driveWith({});
    const model = new DriveTreeModel(drive);
    expect(model.isExpanded('cycles')).toBe(false);
    model.toggle('cycles');
    expect(model.isExpanded('cycles')).toBe(true);
    model.toggle('cycles');
    expect(model.isExpanded('cycles')).toBe(false);
  });

  it('.obsidian est totalement masqué de l arbre navigable', async () => {
    const { drive } = driveWith({
      root: [folder('obs-id', '.obsidian'), file('f1', 'note.md')],
    });
    const model = new DriveTreeModel(drive);
    const nodes = await model.loadChildren('root', '');
    expect(nodes.map((n) => n.name)).toEqual(['note.md']);
  });

  it('un .obsidian imbriqué dans un sous-dossier est aussi masqué', async () => {
    const { drive } = driveWith({
      sub: [folder('obs-id', '.obsidian'), file('f1', 'note.md')],
    });
    const model = new DriveTreeModel(drive);
    const nodes = await model.loadChildren('sub', 'sous-dossier');
    expect(nodes.map((n) => n.name)).toEqual(['note.md']);
  });

  it('un nom Drive malveillant (traversée de chemin) est masqué de l arbre — sécurité', async () => {
    const { drive } = driveWith({
      root: [file('evil', '../../../etc/passwd'), folder('d1', '..'), file('f1', 'note.md')],
    });
    const model = new DriveTreeModel(drive);
    const nodes = await model.loadChildren('root', '');
    expect(nodes.map((n) => n.name)).toEqual(['note.md']);
  });

  it('persiste le cache et le relit au redémarrage (survit à une nouvelle instance)', async () => {
    const { a } = memAdapter();
    const { drive, http } = driveWith({ root: [file('f1', 'a.md')] });
    const m1 = new DriveTreeModel(drive, a);
    await m1.load();
    await m1.loadChildren('root', '');
    expect(http).toHaveBeenCalledTimes(1);

    // nouvelle instance dont le Drive est injoignable : le cache persisté doit suffire à
    // afficher l'arbre SANS aucune tentative réseau (donc pas marqué offline — on n'a pas
    // essayé d'aller en ligne ; le témoin n'apparaît qu'à un refetch qui échoue).
    const offlineHttp = vi.fn<HttpFn>(async () => { throw new Error('net::ERR'); });
    const m2 = new DriveTreeModel(new DriveClient(offlineHttp, async () => 'AT'), a);
    await m2.load();
    const nodes = await m2.loadChildren('root', '');
    expect(nodes.map((n) => n.name)).toEqual(['a.md']);
    expect(offlineHttp).not.toHaveBeenCalled(); // servi depuis le cache, zéro réseau
    expect(m2.isOffline()).toBe(false);
  });

  it('hors-ligne sans cache : remonte l erreur (rien à afficher)', async () => {
    const model = new DriveTreeModel(driveOffline());
    await expect(model.loadChildren('root', '')).rejects.toThrow();
    expect(model.isOffline()).toBe(true);
  });

  it('un problème d auth (NEED_INTERACTIVE_AUTH) n est PAS traité comme hors-ligne', async () => {
    const model = new DriveTreeModel(driveOffline('auth'));
    await expect(model.loadChildren('root', '')).rejects.toThrow('NEED_INTERACTIVE_AUTH');
    expect(model.isOffline()).toBe(false);
  });

  it('invalidate + refetch hors-ligne : garde le cache au lieu de le perdre', async () => {
    const { a } = memAdapter();
    const { drive } = driveWith({ root: [file('f1', 'a.md')] });
    const model = new DriveTreeModel(drive, a);
    await model.load();
    await model.loadChildren('root', ''); // met en cache
    // simule une bascule hors-ligne : on remplace le drive par un injoignable
    (model as unknown as { drive: DriveClient }).drive = driveOffline();
    model.invalidate('root'); // force refetch → échouera
    const nodes = await model.loadChildren('root', '');
    expect(nodes.map((n) => n.name)).toEqual(['a.md']); // cache préservé
    expect(model.isOffline()).toBe(true);
  });

  it('fusionne les fichiers LOCAUX absents de Drive en nœuds « local-only » (grisés)', async () => {
    const { drive } = driveWith({ root: [file('f1', 'sur-drive.md')] });
    const listLocal = (p: string) =>
      p === '' ? [{ name: 'sur-drive.md', isFolder: false }, { name: 'local-seul.md', isFolder: false }, { name: '.obsidian', isFolder: true }] : [];
    const model = new DriveTreeModel(drive, undefined, undefined, listLocal);
    const nodes = await model.loadChildren('root', '');
    const names = nodes.map((n) => n.name);
    expect(names).toContain('sur-drive.md');
    expect(names).toContain('local-seul.md'); // présent en local, pas sur Drive → local-only
    expect(names).not.toContain('.obsidian'); // ignoré
    const local = nodes.find((n) => n.name === 'local-seul.md');
    expect(local?.localOnly).toBe(true);
    expect(local?.id.startsWith('local:')).toBe(true);
    expect(nodes.find((n) => n.name === 'sur-drive.md')?.localOnly).toBeUndefined(); // sur Drive
  });

  it('NFC : un dossier sur Drive en NFD + en local en NFC n est PAS vu comme local-only (anti-doublon)', async () => {
    const base = 'datées';
    const { drive } = driveWith({ root: [folder('d1', base.normalize('NFD'))] });
    const listLocal = (p: string) => (p === '' ? [{ name: base.normalize('NFC'), isFolder: true }] : []);
    const model = new DriveTreeModel(drive, undefined, undefined, listLocal);
    const nodes = await model.loadChildren('root', '');
    expect(nodes.length).toBe(1); // un seul nœud, pas de doublon grisé
    expect(nodes[0].localOnly).toBeUndefined(); // reconnu comme présent sur Drive
  });

  it('un dossier local-only (id local:) se déplie depuis le LOCAL, sans appel Drive', async () => {
    const { drive, http } = driveWith({});
    const listLocal = (p: string) => (p === 'dossierlocal' ? [{ name: 'x.md', isFolder: false }] : []);
    const model = new DriveTreeModel(drive, undefined, undefined, listLocal);
    const nodes = await model.loadChildren('local:dossierlocal', 'dossierlocal');
    expect(http).not.toHaveBeenCalled();
    expect(nodes.map((n) => n.name)).toEqual(['x.md']);
    expect(nodes[0].localOnly).toBe(true);
  });

  it('notifie onStatus au passage en/hors-ligne', async () => {
    const { drive } = driveWith({ root: [file('f1', 'a.md')] });
    const statuses: boolean[] = [];
    const model = new DriveTreeModel(drive, undefined, (o) => statuses.push(o));
    await model.loadChildren('root', ''); // online → pas de changement (déjà false), pas de notif
    (model as unknown as { drive: DriveClient }).drive = driveOffline();
    model.invalidate('root');
    await model.loadChildren('root', '').catch(() => undefined);
    expect(statuses).toContain(true); // passage hors-ligne notifié
  });
});
