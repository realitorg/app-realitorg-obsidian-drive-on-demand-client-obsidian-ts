// src/panel/sync-engine.ts
import { isIgnored, type VaultOps } from '../mirror/tree-mirror';
import type { MirrorIndex, MirrorEntry } from '../mirror/mirror-index';
import type { Hydrator } from '../mirror/hydrator';
import { DriveClient, isGoogleNative, type DriveMeta, type DriveNode } from '../drive/drive-client';
import type { SelectiveSyncState } from './selective-sync-state';
import type { TreeNode } from './tree-model';
import type { CancelToken } from '../util/cancel-token';

/** URL de l'éditeur natif Google (Docs/Sheets/Slides) pour un fichier Google natif. */
export function googleNativeUrl(driveId: string, mimeType: string): string {
  const kind = mimeType.split('.').pop();
  if (kind === 'document') return `https://docs.google.com/document/d/${driveId}/edit`;
  if (kind === 'spreadsheet') return `https://docs.google.com/spreadsheets/d/${driveId}/edit`;
  if (kind === 'presentation') return `https://docs.google.com/presentation/d/${driveId}/edit`;
  return `https://drive.google.com/open?id=${driveId}`;
}

/** Libellé lisible du type de fichier Google natif, pour la note-lien. */
export function googleNativeLabel(mimeType: string): string {
  const kind = mimeType.split('.').pop();
  if (kind === 'document') return 'Google Docs';
  if (kind === 'spreadsheet') return 'Google Sheets';
  if (kind === 'presentation') return 'Google Slides';
  return 'Google Drive';
}

export class SyncEngine {
  constructor(
    private vault: VaultOps,
    private index: MirrorIndex,
    private hydrator: Hydrator,
    private drive: DriveClient,
    private state: SelectiveSyncState,
  ) {}

  private async pruneEmptyParents(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop();
    while (parts.length > 0) {
      const dir = parts.join('/');
      if (this.vault.isEmptyFolder(dir)) {
        await this.vault.remove(dir);
        parts.pop();
      } else break;
    }
  }

  private async ensureParents(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop();
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      await this.vault.createFolder(acc);
    }
  }

  /** Matérialise + hydrate un fichier, sans jamais écraser un fichier préexistant. */
  private async materialize(path: string, meta: DriveMeta): Promise<void> {
    if (isIgnored(path)) return;
    if (await this.vault.exists(path)) return; // ne pas écraser
    await this.ensureParents(path);
    await this.vault.createStub(path);
    const entry: MirrorEntry = {
      driveId: meta.id,
      mimeType: meta.mimeType,
      isFolder: false,
      hydrated: false,
      pinned: true,
      headRevisionId: meta.headRevisionId,
      modifiedTime: meta.modifiedTime,
      md5Checksum: meta.md5Checksum,
    };
    await this.index.set(path, entry);
    await this.hydrator.hydrate(path);
  }

  /** Chemin local .md effectif d'un fichier Google natif (Docs/Sheets/Slides n'ont pas
   *  d'extension côté Drive ; sans .md, Obsidian ne rend pas le fichier comme une note). */
  static googleNativeLocalPath(drivePath: string): string {
    return `${drivePath}.md`;
  }

  /** Fichier Google natif (Docs/Sheets/Slides) : pas de contenu brut téléchargeable —
   *  crée une note .md contenant un lien vers l'éditeur natif, jamais poussée/comparée
   *  (mimeType Google natif conservé dans l'index → exclu par les gardes isGoogleNative).
   *  Retourne le chemin local réellement écrit (path.md), seule source de vérité pour
   *  l'appelant : state/index/checkbox doivent tous pointer vers CE chemin, pas `path`. */
  private async materializeGoogleNativeLink(path: string, meta: DriveMeta): Promise<string> {
    const localPath = SyncEngine.googleNativeLocalPath(path);
    if (isIgnored(localPath)) return localPath;
    if (await this.vault.exists(localPath)) return localPath; // ne jamais écraser
    await this.ensureParents(localPath);
    const url = googleNativeUrl(meta.id, meta.mimeType);
    const label = googleNativeLabel(meta.mimeType);
    const safeName = meta.name.replace(/[[\]]/g, '\\$&');
    const content = `[${safeName}](${url})\n\n*Fichier ${label} — contenu non synchronisé, ce fichier ne contient qu'un lien.*\n`;
    await this.vault.writeText(localPath, content);
    await this.index.set(localPath, {
      driveId: meta.id,
      mimeType: meta.mimeType,
      isFolder: false,
      hydrated: true,
      pinned: true,
      headRevisionId: meta.headRevisionId,
      modifiedTime: meta.modifiedTime,
    });
    return localPath;
  }

  async syncFile(node: TreeNode, token?: CancelToken): Promise<void> {
    token?.throwIfCancelled();
    const meta = node.meta;
    if (!meta) return; // nœud « local-only » : téléversé via CreateManager.uploadLocal, pas ici
    let localPath = node.path;
    if (isGoogleNative(meta.mimeType)) {
      localPath = await this.materializeGoogleNativeLink(node.path, meta);
    } else {
      await this.materialize(node.path, meta);
    }
    await this.state.setFileSynced(localPath, true);
  }

  async unsyncFile(path: string, token?: CancelToken): Promise<void> {
    token?.throwIfCancelled();
    await this.vault.remove(path);
    await this.state.setFileSynced(path, false);
    await this.pruneEmptyParents(path);
  }

  async planFolderSync(node: TreeNode, token?: CancelToken): Promise<DriveNode[]> {
    return this.drive.subtree(node.id, node.path, token);
  }

  async applyFolderSync(
    node: TreeNode,
    nodes: DriveNode[],
    token?: CancelToken,
    onFileDone?: (path: string) => void,
  ): Promise<{ failed: string[] }> {
    if (isIgnored(node.path)) return { failed: [] };
    // dossiers d'abord (du moins profond au plus profond), puis fichiers
    const folders = nodes
      .filter((n) => n.isFolder && !isIgnored(n.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    token?.throwIfCancelled();
    await this.vault.createFolder(node.path);
    for (const f of folders) {
      token?.throwIfCancelled();
      await this.vault.createFolder(f.path);
    }
    // indexer le dossier racine et les sous-dossiers
    await this.index.set(node.path, {
      driveId: node.id, mimeType: node.meta?.mimeType ?? 'application/vnd.google-apps.folder', isFolder: true, hydrated: true, pinned: true,
    });
    for (const f of folders) {
      await this.index.set(f.path, {
        driveId: f.id, mimeType: f.mimeType, isFolder: true, hydrated: true, pinned: true,
      });
    }
    const files = nodes.filter((n) => !n.isFolder && !isIgnored(n.path));
    const newlyCreatedThisRun: string[] = [];
    const succeeded: string[] = [];
    const failed: string[] = [];
    try {
      for (const f of files) {
        token?.throwIfCancelled();
        const isNative = isGoogleNative(f.mimeType);
        const localPath = isNative ? SyncEngine.googleNativeLocalPath(f.path) : f.path;
        const alreadyPresent = await this.vault.exists(localPath);
        try {
          if (isNative) await this.materializeGoogleNativeLink(f.path, f);
          else await this.materialize(f.path, f);
          await this.state.setFileSynced(localPath, true);
          if (!alreadyPresent) newlyCreatedThisRun.push(localPath);
          succeeded.push(localPath);
        } catch {
          // échec isolé sur CE fichier : on continue avec les suivants, on ne
          // laisse jamais un seul fichier bloquer tout le reste du dossier.
          failed.push(localPath);
        }
        // notifie CE fichier terminé (succès ou échec) — permet à l'UI de faire
        // disparaître son spinner immédiatement, sans attendre tout le dossier
        onFileDone?.(localPath);
        // re-vérifie après coup : capte une annulation survenue pendant le
        // traitement du DERNIER fichier de la boucle (pas de tour suivant pour
        // la détecter au sommet de la boucle)
        token?.throwIfCancelled();
      }
    } catch (e) {
      // seule une vraie annulation (throwIfCancelled, hors du try par-fichier
      // ci-dessus) peut atteindre ce catch — on défait uniquement ce qui a été
      // créé PENDANT cette tentative, les fichiers déjà synchronisés d'une
      // exécution précédente restent intacts
      for (const p of newlyCreatedThisRun) {
        await this.vault.remove(p);
        await this.state.setFileSynced(p, false);
        await this.pruneEmptyParents(p);
      }
      throw e;
    }
    // ne marque le dossier « complet » que si TOUS les fichiers ont réussi —
    // sinon son état tri-état reste « partiel » (des fichiers sont synchronisés
    // individuellement, mais pas la totalité), ce qui reflète honnêtement la réalité.
    if (failed.length === 0) {
      await this.state.setFolderFull(node.path, succeeded, folders.map((f) => f.path), true);
    }
    return { failed };
  }

  /** Désynchronise TOUT (changement de dossier de travail) : retire du vault chaque
   *  fichier synchronisé, élague les dossiers vides, puis remet l'état et l'index à zéro
   *  (leurs chemins étaient relatifs à l'ancienne racine). Les fichiers restent sur Drive. */
  async unsyncAll(token?: CancelToken): Promise<void> {
    for (const p of this.state.allSynced()) {
      token?.throwIfCancelled();
      await this.vault.remove(p);
      await this.pruneEmptyParents(p);
    }
    await this.state.clear();
    await this.index.clear();
  }

  async unsyncFolder(node: TreeNode, token?: CancelToken): Promise<void> {
    const files = this.state.syncedUnder(node.path);
    for (const p of files) {
      token?.throwIfCancelled();
      await this.vault.remove(p);
      await this.state.setFileSynced(p, false);
      await this.pruneEmptyParents(p);
    }
    await this.state.setFolderFull(node.path, [], [], false);
    // le dossier lui-même doit disparaître s'il est maintenant vide (y compris le cas
    // d'un dossier qui n'a jamais contenu aucun fichier synchronisé) — jamais s'il
    // contient encore un sous-dossier ou un fichier non pris en charge par cette désync.
    if (this.vault.isEmptyFolder(node.path)) {
      await this.vault.remove(node.path);
      await this.pruneEmptyParents(node.path);
    }
  }
}
