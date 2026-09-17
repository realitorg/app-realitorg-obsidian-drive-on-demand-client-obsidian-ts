import { DriveClient, isFolder, type DriveMeta } from '../drive/drive-client';
import { isIgnored } from '../mirror/tree-mirror';
import { toNfc } from '../util/nfc';
import type { PersistAdapter } from '../auth/token-store';

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  /** Présent uniquement pour les nœuds venant de Drive ; absent pour les nœuds « local-only ». */
  meta?: DriveMeta;
  /** Vrai si le fichier/dossier existe en LOCAL mais pas (encore) sur Drive — affiché grisé,
   *  case = « téléverser ». Ces nœuds ont un id synthétique `local:<path>` et pas de meta. */
  localOnly?: boolean;
}

const LOCAL_ID_PREFIX = 'local:';
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** Modèle de l'arbre Drive avec cache PERSISTANT (survit au redémarrage) et repli
 *  hors-ligne. Le cache stocke les métadonnées brutes (DriveMeta) par identifiant de
 *  dossier — indépendantes du chemin, donc valides quel que soit le dossier de travail ;
 *  les chemins sont recalculés à chaque `loadChildren` à partir de `parentPath`. */
export class DriveTreeModel {
  private cache = new Map<string, DriveMeta[]>();
  private stale = new Set<string>(); // dossiers à refetch (invalidés) sans perdre le cache offline
  private expanded = new Set<string>();
  private offline = false;

  constructor(
    private drive: DriveClient,
    private adapter?: PersistAdapter,
    private onStatus?: (offline: boolean) => void,
    /** Liste les enfants LOCAUX d'un dossier du vault — pour afficher les fichiers
     *  présents en local mais absents de Drive (« local-only », grisés). */
    private listLocal?: (path: string) => { name: string; isFolder: boolean }[],
  ) {}

  /** Recharge le cache persisté (au démarrage). Sans adapter : no-op. */
  async load(): Promise<void> {
    if (!this.adapter) return;
    const d = await this.adapter.load();
    const folders = d.folders;
    if (folders && typeof folders === 'object' && !Array.isArray(folders)) {
      for (const [id, metas] of Object.entries(folders as Record<string, unknown>)) {
        if (Array.isArray(metas)) this.cache.set(id, metas as DriveMeta[]);
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.adapter) return;
    const folders: Record<string, DriveMeta[]> = {};
    for (const [id, metas] of this.cache) folders[id] = metas;
    const d = await this.adapter.load();
    d.folders = folders;
    await this.adapter.save({ ...d });
  }

  isOffline(): boolean {
    return this.offline;
  }

  private setOffline(v: boolean): void {
    if (this.offline !== v) {
      this.offline = v;
      this.onStatus?.(v);
    }
  }

  async loadChildren(folderId: string, parentPath: string): Promise<TreeNode[]> {
    // Dossier « local-only » (pas sur Drive) : aucun appel Drive, uniquement le contenu local.
    if (isLocalId(folderId)) {
      return this.sortNodes(this.localOnlyNodes(parentPath, new Set()));
    }
    let metas: DriveMeta[];
    const cached = this.cache.get(folderId);
    const needFetch = !cached || this.stale.has(folderId);
    if (needFetch) {
      try {
        metas = await this.drive.children(folderId);
        this.cache.set(folderId, metas);
        this.stale.delete(folderId);
        this.setOffline(false);
        await this.persist();
      } catch (e) {
        // Un problème d'AUTH (non connecté) n'est PAS du hors-ligne : on le laisse remonter.
        if (String(e).includes('NEED_INTERACTIVE_AUTH')) throw e;
        // Réseau/Drive injoignable : repli sur le cache si on en a un, sinon on remonte l'erreur.
        this.setOffline(true);
        if (!cached) throw e;
        metas = cached;
      }
    } else {
      metas = cached;
    }
    return this.mergeWithLocal(metas, parentPath);
  }

  /** Fusionne les nœuds Drive avec les fichiers LOCAUX absents de Drive (grisés). */
  private mergeWithLocal(metas: DriveMeta[], parentPath: string): TreeNode[] {
    const driveNodes: TreeNode[] = metas
      .map((m) => ({
        id: m.id,
        name: m.name,
        path: parentPath ? `${parentPath}/${m.name}` : m.name,
        isFolder: isFolder(m.mimeType),
        meta: m,
      }))
      .filter((n) => !isIgnored(n.path));
    // Comparaison NFC des deux côtés : Drive renvoie souvent du NFD (upload macOS via Drive
    // Desktop), Obsidian du NFC → sans ça, un fichier présent des deux côtés apparaîtrait à
    // tort « local-only » et son téléversement créerait un DOUBLON sur Drive.
    const driveNames = new Set(driveNodes.map((n) => toNfc(n.name)));
    return this.sortNodes([...driveNodes, ...this.localOnlyNodes(parentPath, driveNames)]);
  }

  private localOnlyNodes(parentPath: string, exclude: Set<string>): TreeNode[] {
    if (!this.listLocal) return [];
    return this.listLocal(parentPath)
      .filter((c) => !exclude.has(toNfc(c.name)))
      .map((c) => {
        const path = parentPath ? `${parentPath}/${c.name}` : c.name;
        return { id: `${LOCAL_ID_PREFIX}${path}`, name: c.name, path, isFolder: c.isFolder, localOnly: true };
      })
      .filter((n) => !isIgnored(n.path));
  }

  private sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }
  toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
  }

  /** Force un refetch au prochain loadChildren SANS jeter le cache (préservé pour le
   *  repli hors-ligne si le refetch échoue). */
  invalidate(folderId: string): void {
    this.stale.add(folderId);
  }

  /** Comme `invalidate`, mais pour TOUS les dossiers déjà en cache : sans ça, un
   *  renommage/déplacement fait sur Drive dans un SOUS-dossier n'apparaît jamais
   *  dans le panneau (le cache d'un sous-dossier est persistant et n'expire pas). */
  invalidateAll(): void {
    for (const id of this.cache.keys()) this.stale.add(id);
  }
}
