import type { MirrorIndex } from '../mirror/mirror-index';
import type { SelectiveSyncState } from './selective-sync-state';
import { reindexPaths, untrackPaths } from '../mirror/reindex';
import { MASS_DELETE_THRESHOLD, topLevel } from './delete-relay';
import { isIgnored } from '../mirror/tree-mirror';
import { toNfc } from '../util/nfc';
import type { PersistAdapter } from '../auth/token-store';

interface RemoteDrive {
  getStartPageToken(): Promise<string>;
  getRootFolderId(): Promise<string>;
  fileStatus(fileId: string): Promise<{ gone: true } | { gone: false; parents: string[] }>;
  listChanges(pageToken: string): Promise<{
    changes: { fileId: string; removed: boolean; name?: string; parents?: string[]; mimeType?: string }[];
    newStartPageToken?: string;
    nextPageToken?: string;
  }>;
}
interface RemotePull {
  refreshFile(path: string): Promise<unknown>;
}
interface RemoteVault {
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Vers le `.trash` du vault, jamais une suppression définitive. */
  trashToVault(path: string): Promise<void>;
}

export interface RemoteChangeSyncOptions {
  drive: RemoteDrive;
  index: MirrorIndex;
  state: SelectiveSyncState;
  vault: RemoteVault;
  pull: RemotePull;
  /** Id Drive de la racine de travail (« root » ou id d'un dossier de travail). */
  rootId: () => string;
  adapter: PersistAdapter; // persiste le jeton de page des changements
  onRename?: (oldPath: string, newPath: string) => void;
  /** Un NOUVEAU fichier est apparu sur Drive dans un dossier synchronisé en entier :
   *  re-synchronise ce dossier (matérialise les nouveautés, idempotent). */
  resyncFullFolder?: (folderPath: string) => Promise<void>;
  /** Drive a signalé des changements (suivis ou non) : le panneau doit relire l'arbre,
   *  son cache persistant n'expire jamais de lui-même. */
  onRemoteChanges?: () => void;
  /** Vrai si `path` (ou son contenu) a des modifications locales pas encore envoyées. */
  hasPendingPush?: (path: string) => boolean;
  /** Plus de MASS_DELETE_THRESHOLD éléments supprimés sur Drive : vrai si l'utilisateur
   *  confirme. Absent : rien n'est supprimé en local. */
  confirmMassDelete?: (count: number) => Promise<boolean>;
}

/** Balayage complet périodique : demande à Drive « qu'est-ce qui a changé ? » (API Changes)
 *  et répercute en LOCAL, pour les fichiers/dossiers déjà synchronisés :
 *   - renommé / déplacé sur Drive → renommé / déplacé en local (+ réindexation) ;
 *   - contenu modifié → tiré ;
 *   - supprimé, mis à la corbeille ou devenu inaccessible → `.trash` du vault, sauf
 *     modifications locales pas encore envoyées (le fichier est alors seulement oublié).
 *  Ne télécharge les nouveaux fichiers Drive que sous un dossier synchronisé en entier.
 *  Complète le rafraîchissement 5 s des notes ouvertes. */
export class RemoteChangeSync {
  private token: string | null = null;
  private rootMappingId?: string;

  constructor(private opts: RemoteChangeSyncOptions) {}

  async load(): Promise<void> {
    const d = await this.opts.adapter.load();
    this.token = typeof d.changesToken === 'string' ? d.changesToken : null;
  }

  private async saveToken(tok: string): Promise<void> {
    this.token = tok;
    const d = await this.opts.adapter.load();
    d.changesToken = tok;
    await this.opts.adapter.save({ ...d });
  }

  /** L'alias « root » ne correspond pas aux `parents` de l'API : on résout l'id réel une fois. */
  private async rootMapping(): Promise<string> {
    if (this.rootMappingId === undefined) {
      const rid = this.opts.rootId();
      this.rootMappingId = rid === 'root' ? await this.opts.drive.getRootFolderId() : rid;
    }
    return this.rootMappingId;
  }

  async scan(): Promise<void> {
    if (!this.token) {
      // premier passage : point de référence « maintenant » (pas d'historique à rejouer)
      await this.saveToken(await this.opts.drive.getStartPageToken());
      return;
    }
    const rootMappingId = await this.rootMapping();

    const changes: { fileId: string; removed: boolean; name?: string; parents?: string[] }[] = [];
    let pageToken: string | undefined = this.token;
    let newToken = this.token;
    while (pageToken) {
      const r = await this.opts.drive.listChanges(pageToken);
      changes.push(...r.changes);
      if (r.nextPageToken) pageToken = r.nextPageToken;
      else {
        newToken = r.newStartPageToken ?? newToken;
        pageToken = undefined;
      }
    }

    const byId = new Map<string, string>(); // driveId → chemin local (fichiers ET dossiers)
    for (const p of this.opts.index.paths()) {
      const e = this.opts.index.get(p);
      if (e) byId.set(e.driveId, p);
    }

    const resyncFolders = new Set<string>(); // dossiers full-sync ayant reçu un nouveau fichier
    const removed: string[] = [];
    for (const c of changes) {
      const curPath = byId.get(c.fileId);
      if (!curPath) {
        // Nouveau fichier / non suivi. On ne le matérialise QUE si son dossier parent est
        // synchronisé en entier (full) — sinon la sync reste sélective (ignoré, comme avant).
        if (!c.removed) {
          const parentPath = this.resolveParentPath(c, rootMappingId, byId);
          if (parentPath !== undefined && this.opts.state.isUnderFullFolder(parentPath)) {
            resyncFolders.add(parentPath);
          }
        }
        continue;
      }
      if (c.removed) {
        removed.push(curPath);
        continue;
      }
      const entry = this.opts.index.get(curPath);
      if (!entry) continue;

      const newPath = this.computeNewPath(curPath, c, rootMappingId, byId);
      if (newPath !== curPath && !isIgnored(newPath)) {
        await this.opts.vault.rename(curPath, newPath); // renommé/déplacé sur Drive → en local
        await reindexPaths(this.opts.index, this.opts.state, curPath, newPath);
        this.opts.onRename?.(curPath, newPath);
        if (!entry.isFolder) await this.opts.pull.refreshFile(newPath);
      } else if (!entry.isFolder) {
        await this.opts.pull.refreshFile(curPath); // contenu éventuellement modifié
      }
    }

    await this.applyRemovals(topLevel(removed));

    // Matérialise les nouveaux fichiers des dossiers full-sync touchés (idempotent).
    for (const folderPath of resyncFolders) await this.opts.resyncFullFolder?.(folderPath);

    if (newToken !== this.token) await this.saveToken(newToken);
    if (changes.length > 0) this.opts.onRemoteChanges?.();
  }

  /** Éléments encore suivis mais absents de leur dossier sur le drive (supprimés quand le
   *  plugin ne répercutait pas encore les suppressions, ou pendant qu'il était arrêté :
   *  aucun changement ne les signalera plus). Vérifiés un par un : disparus → mêmes règles
   *  qu'une suppression distante ; déplacés ailleurs → plus suivis, copie locale gardée. */
  async reconcileOrphans(paths: string[]): Promise<void> {
    const rootMappingId = await this.rootMapping();
    const gone: string[] = [];
    let changed = false;
    for (const p of topLevel(paths)) {
      const entry = this.opts.index.get(p);
      if (!entry) continue;
      const st = await this.opts.drive.fileStatus(entry.driveId);
      if (st.gone) {
        gone.push(p);
        continue;
      }
      const parentPath = p.split('/').slice(0, -1).join('/');
      const expected = parentPath ? this.opts.index.get(parentPath)?.driveId : rootMappingId;
      if (expected && st.parents.includes(expected)) continue; // toujours là : liste pas encore à jour
      await untrackPaths(this.opts.index, this.opts.state, p);
      changed = true;
    }
    await this.applyRemovals(gone);
    if (changed || gone.length > 0) this.opts.onRemoteChanges?.();
  }

  private async applyRemovals(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const propagate =
      paths.length <= MASS_DELETE_THRESHOLD || ((await this.opts.confirmMassDelete?.(paths.length)) ?? false);
    for (const p of paths) {
      if (propagate && !this.opts.hasPendingPush?.(p)) await this.opts.vault.trashToVault(p);
      await untrackPaths(this.opts.index, this.opts.state, p);
    }
  }

  /** Chemin local du dossier parent d'un fichier changé (racine → '', dossier suivi → son chemin). */
  private resolveParentPath(
    c: { parents?: string[] },
    rootMappingId: string,
    byId: Map<string, string>,
  ): string | undefined {
    const parentId = c.parents?.[0];
    if (!parentId) return undefined;
    if (parentId === rootMappingId) return '';
    return byId.get(parentId);
  }

  /** Chemin local attendu d'après le nom + parent Drive actuels du fichier changé. */
  private computeNewPath(
    curPath: string,
    c: { name?: string; parents?: string[] },
    rootMappingId: string,
    byId: Map<string, string>,
  ): string {
    const newName = c.name ? toNfc(c.name) : undefined;
    if (!newName) return curPath;
    const parentId = c.parents?.[0];
    let parentPath: string | undefined;
    if (parentId === rootMappingId) parentPath = '';
    else if (parentId) parentPath = byId.get(parentId); // dossier suivi
    if (parentPath === undefined) {
      // parent Drive inconnu (déplacé hors zone suivie) : on applique juste le nom, même dossier
      const dir = curPath.split('/').slice(0, -1).join('/');
      return dir ? `${dir}/${newName}` : newName;
    }
    return parentPath ? `${parentPath}/${newName}` : newName;
  }
}
