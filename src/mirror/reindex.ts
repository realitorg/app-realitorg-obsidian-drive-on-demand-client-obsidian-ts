import type { MirrorIndex } from './mirror-index';
import type { SelectiveSyncState } from '../panel/selective-sync-state';

/** Déplace les clés d'index ET d'état de synchronisation de `oldPath` (et de tout son
 *  sous-arbre) vers `newPath`. Utilisé quand un fichier/dossier synchronisé est renommé
 *  ou déplacé (dans un sens comme dans l'autre : local→Drive et Drive→local). */
export async function reindexPaths(
  index: MirrorIndex,
  state: SelectiveSyncState,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (oldPath === newPath) return;
  const affected = index.paths().filter((p) => p === oldPath || p.startsWith(oldPath + '/'));
  for (const p of affected) {
    const entry = index.get(p);
    if (!entry) continue;
    const np = newPath + p.slice(oldPath.length);
    const wasSynced = state.isSynced(p);
    await index.delete(p);
    await index.set(np, entry);
    if (wasSynced) {
      await state.setFileSynced(p, false);
      await state.setFileSynced(np, true);
    }
  }
}

/** Cesse de suivre `path` et tout son sous-arbre (index et état), sans toucher aux
 *  fichiers ni rétrograder les dossiers parents : l'élément a disparu d'un côté. */
export async function untrackPaths(index: MirrorIndex, state: SelectiveSyncState, path: string): Promise<void> {
  for (const p of index.paths()) {
    if (p === path || p.startsWith(path + '/')) await index.delete(p);
  }
  await state.forget(path);
}
