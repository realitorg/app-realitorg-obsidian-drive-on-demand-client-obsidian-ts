// src/panel/tree-view.ts
import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import { DriveTreeModel, type TreeNode } from './tree-model';
import type { SelectiveSyncState } from './selective-sync-state';
import type { CreateManager } from './create-manager';
import { SyncEngine } from './sync-engine';
import { DriveClient, isGoogleNative } from '../drive/drive-client';
import { CancelToken, isCancelledError } from '../util/cancel-token';
import type { WorkingRootStore } from './working-root';
import { SyncDetailsModal, type SyncDetailsController, type SyncStatus } from './sync-details-modal';
import { t } from '../i18n';
import { toNfc } from '../util/nfc';

export const VIEW_TYPE = 'gdrive-fod-tree';

export class DriveTreeView extends ItemView {
  private treeEl!: HTMLElement;
  private renderGeneration = 0;
  // NB : ne PAS nommer ce champ `titleEl` — c'est une propriété réservée d'ItemView/View
  // dans Obsidian (obsidian.d.ts). Un champ de classe du même nom l'écrase avec `undefined`
  // à la construction, et l'ouverture interne de la vue (`this.titleEl.setText(...)`) plante
  // → « Cannot read properties of undefined (reading 'setText') », panneau blanc.
  private panelTitleEl!: HTMLElement;
  private refreshIconEl?: HTMLElement;
  private syncing = new Set<string>();
  private cancelTokens = new Map<string, CancelToken>();
  /** Fichiers déjà traités (succès ou échec) au sein d'une sync de dossier encore en
   *  cours — leur spinner doit disparaître dès leur propre fin, sans attendre que
   *  syncing.delete(dossier) n'arrive à la toute fin de l'opération complète. */
  private doneWithinSync = new Set<string>();
  /** Progression d'une sync de dossier en cours, par chemin racine (pour l'affichage en %). */
  private syncProgress = new Map<string, { done: number; total: number }>();
  private accountEmail?: string;
  /** Fichiers en échec lors de la dernière sync, par chemin du nœud synchronisé. */
  private failures = new Map<string, string[]>();
  private details?: SyncDetailsModal;

  constructor(
    leaf: WorkspaceLeaf,
    private model: DriveTreeModel,
    private state: SelectiveSyncState,
    private engine: SyncEngine,
    private drive: DriveClient,
    private workingRoot: WorkingRootStore,
    private create: CreateManager,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return t('panel.title');
  }
  getIcon(): string {
    return 'cloud';
  }

  async onOpen(): Promise<void> {
    // Quand Internet revient, on rafraîchit les données du panneau (l'ÉTAT de connexion,
    // lui, n'est affiché QUE dans la status bar). registerDomEvent est nettoyé auto.
    this.registerDomEvent(window, 'online', () => void this.revalidate());
    // Le panneau ne doit JAMAIS rester blanc silencieusement : toute erreur d'ouverture
    // est rendue visible à l'écran (message + stack), pas seulement dans la console.
    try {
      await this.renderPanel();
    } catch (e) {
      this.renderFatalError(e);
    }
  }

  private async renderPanel(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    const header = root.createDiv({ cls: 'gdrive-fod-header' });
    // Titre + arbre créés EN PREMIER → toujours visibles, même si la décoration du
    // header (icône rafraîchir / dossier) venait à échouer. Le panneau ne peut plus être blanc.
    this.panelTitleEl = header.createSpan({ cls: 'gdrive-fod-title is-clickable' });
    this.updateTitle();
    this.treeEl = root.createDiv({ cls: 'gdrive-fod-tree' });
    // Décoration isolée : icônes du header = un « plus », jamais un point de blocage.
    try {
      const refreshIcon = header.createSpan({ cls: 'gdrive-fod-refresh-icon' });
      header.prepend(refreshIcon); // à gauche du titre
      setIcon(refreshIcon, 'refresh-cw');
      refreshIcon.setAttr('aria-label', t('panel.refreshButton'));
      refreshIcon.setAttr('role', 'button');
      refreshIcon.onclick = () => void this.refresh();
      this.refreshIconEl = refreshIcon;
    } catch (e) {
      console.error('[gdrive-fod] décoration du header échouée (non bloquant)', e);
    }
    void this.loadAccountEmail();
    await this.render();          // affichage instantané (cache si disponible)
    void this.revalidate();       // en arrière-plan : rafraîchit la racine si en ligne
  }

  /** Revalidation silencieuse (sans spinner) de l'arbre : rafraîchit les données quand
   *  c'est possible ; en cas d'échec réseau, le cache reste affiché (le modèle gère le
   *  repli hors-ligne). L'ÉTAT de connexion est affiché uniquement dans la status bar.
   *  Invalide TOUT le cache (pas seulement la racine) : le rendu ne redescend que dans
   *  les dossiers dépliés, donc le coût réel est d'un appel Drive par dossier ouvert. */
  /** Des changements sont arrivés de Drive (renommage, déplacement, ajout, suppression). */
  onRemoteChanges(): Promise<void> {
    return this.revalidate();
  }

  private async revalidate(): Promise<void> {
    if (!this.treeEl) return; // vue pas encore rendue (ex. événement réseau très tôt)
    this.model.invalidateAll();
    await this.render();
  }

  /** Titre du header : nom du dossier de travail si défini, sinon l'email du compte
   *  (dès qu'il est connu), sinon le libellé générique. */
  private updateTitle(): void {
    if (!this.panelTitleEl) return;
    const wr = this.workingRoot.get();
    if (wr) this.panelTitleEl.setText('📁 ' + wr.name);
    else this.panelTitleEl.setText(this.accountEmail ?? t('panel.title'));
  }

  /** Le dossier de travail a changé (depuis les réglages) : recharge l'arbre et le titre.
   *  La sélection elle-même vit dans les réglages du plugin, pas dans ce panneau. */
  async onWorkingRootChanged(): Promise<void> {
    this.model.invalidate(this.workingRoot.rootId());
    this.updateTitle();
    await this.render();
  }

  /** Dernier rempart : affiche l'erreur d'ouverture directement dans le panneau
   *  (au lieu d'un blanc muet), pour qu'elle soit lisible sans ouvrir la console. */
  private renderFatalError(e: unknown): void {
    console.error('[gdrive-fod] onOpen a échoué', e);
    try {
      const root = this.contentEl;
      root.empty();
      const box = root.createDiv({ cls: 'gdrive-fod-fatal' });
      box.createDiv({ text: '⚠ Drive on Demand — ' + t('panel.error', { error: '' }) });
      const pre = box.createEl('pre');
      pre.setText(e instanceof Error ? (e.stack ?? e.message) : String(e));
    } catch (inner) {
      console.error('[gdrive-fod] échec du rendu de l erreur', inner, e);
    }
  }

  /** Affiche l email du compte Google connecté à la place de « Google Drive » dès
   *  qu'il est connu — best-effort, ne bloque jamais l'ouverture du panneau (pas
   *  encore connecté, token expiré, etc. → le titre générique reste affiché). */
  private async loadAccountEmail(): Promise<void> {
    try {
      const { email } = await this.drive.aboutUser();
      if (email) {
        this.accountEmail = email;
        this.updateTitle(); // n'écrase pas un nom de dossier de travail (cf. updateTitle)
      }
    } catch {
      // pas connecté / erreur réseau : garder le titre générique, non bloquant
    }
  }

  /** Construit l'arbre hors du DOM puis remplace le contenu d'un seul coup : vider
   *  `treeEl` avant un rendu asynchrone ramenait le scroll en haut à chaque fichier
   *  synchronisé. Seul le rendu le plus récent est appliqué (une sync de dossier en
   *  lance un par fichier, sans les attendre). */
  private async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    const out = createDiv();
    try {
      const rootId = this.workingRoot.rootId();
      const rootNodes = await this.model.loadChildren(rootId, '');
      for (const n of rootNodes) await this.renderNode(out, n, 0, rootId);
    } catch (e) {
      out.empty();
      if (String(e).includes('NEED_INTERACTIVE_AUTH')) {
        out.createDiv({ text: t('panel.notConnected') });
      } else {
        out.createDiv({ text: t('panel.error', { error: String(e) }) });
      }
    }
    if (generation !== this.renderGeneration) return;
    this.treeEl.replaceChildren(...Array.from(out.childNodes));
    this.details?.refresh();
  }

  private async refresh(): Promise<void> {
    // refreshIconEl peut être absent si la décoration du header a échoué (cf. renderPanel).
    this.refreshIconEl?.addClass('is-spinning');
    try {
      this.model.invalidateAll();
      await this.render();
    } finally {
      this.refreshIconEl?.removeClass('is-spinning');
    }
  }

  /** Chemin local réellement suivi par le state/index pour ce nœud — les fichiers Google
   *  natifs (Docs/Sheets/Slides) sont matérialisés sous `<path>.md` (voir SyncEngine). */
  private effectivePath(node: TreeNode): string {
    return !node.isFolder && node.meta && isGoogleNative(node.meta.mimeType)
      ? SyncEngine.googleNativeLocalPath(node.path)
      : node.path;
  }

  /** Le nœud syncing (lui-même ou un ancêtre dont la sync est en cours) dont dépend `path`,
   *  ou undefined si rien n'est en cours. Un dossier en cours de sync/désync met en spinner
   *  tout son sous-arbre affiché (chargé ou pas encore chargé au moment du clic), jusqu'à ce
   *  que l'opération complète — fichier ou dossier — se termine. */
  private syncingAncestor(path: string): string | undefined {
    if (this.doneWithinSync.has(path)) return undefined; // déjà traité individuellement
    if (this.syncing.has(path)) return path;
    for (const s of this.syncing) {
      if (path.startsWith(s + '/')) return s;
    }
    return undefined;
  }

  /** Aligne l'état du dossier sur son contenu réel, d'après le cache seul (aucun appel
   *  réseau) : oublie ce qui n'existe plus ni sur Drive ni en local, puis marque « plein »
   *  un dossier dont tout le contenu est synchronisé. Seule la sync d'un dossier le marquait
   *  plein : coché enfant par enfant, ou vidé ailleurs, il restait « partiel ». */
  private async reconcile(folder: TreeNode): Promise<void> {
    if (this.syncingAncestor(folder.path)) return;
    const children = this.model.cachedChildren(folder.id, folder.path);
    if (children && this.model.isFresh(folder.id)) {
      const names = new Set<string>();
      for (const c of children) {
        names.add(toNfc(c.name));
        names.add(toNfc(this.effectivePath(c).split('/').pop() ?? c.name));
      }
      await this.state.pruneMissingChildren(folder.path, names);
    }
    if (this.state.folderState(folder.path) === 'partial' && this.allChildrenSynced(folder)) {
      await this.state.setFolderFull(folder.path, [], [], true);
    }
  }

  /** Tout le contenu Drive du dossier est-il synchronisé, d'après le cache seul ? */
  private allChildrenSynced(folder: TreeNode): boolean {
    const children = this.model.cachedChildren(folder.id, folder.path)?.filter((c) => !c.localOnly);
    if (!children || children.length === 0) return false;
    return children.every((c) =>
      c.isFolder
        ? this.state.folderState(c.path) === 'checked' || this.allChildrenSynced(c)
        : this.state.isSynced(this.effectivePath(c)),
    );
  }

  private status(node: TreeNode): SyncStatus {
    const failed = this.failures.get(node.path) ?? [];
    if (this.syncingAncestor(node.path)) return { kind: 'syncing', progress: this.syncProgress.get(node.path), failed };
    const st = node.isFolder ? this.state.folderState(node.path) : this.state.fileState(this.effectivePath(node));
    return { kind: st === 'checked' ? 'offline' : st === 'partial' ? 'partial' : 'online', failed };
  }

  /** Rend `node` disponible hors ligne (`on`) ou libère sa copie locale (jamais sur Drive). */
  private async runSync(node: TreeNode, on: boolean): Promise<void> {
    if (this.syncing.has(node.path)) return;
    const token = new CancelToken();
    this.cancelTokens.set(node.path, token);
    this.syncing.add(node.path);
    this.failures.delete(node.path);
    await this.render();
    const thisRunDone: string[] = [];
    try {
      if (!node.isFolder) {
        if (on) await this.engine.syncFile(node, token);
        else await this.engine.unsyncFile(this.effectivePath(node), token);
      } else if (on) {
        const plan = await this.engine.planFolderSync(node, token);
        const total = plan.filter((n) => !n.isFolder).length;
        this.syncProgress.set(node.path, { done: 0, total });
        const result = await this.engine.applyFolderSync(node, plan, token, (path) => {
          thisRunDone.push(path);
          this.doneWithinSync.add(path);
          const p = this.syncProgress.get(node.path);
          if (p) p.done++;
          void this.render();
        });
        if (result.failed.length > 0) {
          this.failures.set(node.path, result.failed);
          new Notice(t('panel.someFilesFailed', { count: result.failed.length }));
        }
      } else {
        await this.engine.unsyncFolder(node, token);
      }
    } catch (err) {
      if (!isCancelledError(err)) new Notice(t('panel.errorSync', { error: String(err) }));
    } finally {
      this.cancelTokens.delete(node.path);
      this.syncing.delete(node.path);
      this.syncProgress.delete(node.path);
      for (const p of thisRunDone) this.doneWithinSync.delete(p);
      await this.render();
    }
  }

  private openDetails(node: TreeNode): void {
    if (this.details?.node.path === node.path) return;
    this.details?.close();
    const ctl: SyncDetailsController = {
      status: (n) => this.status(n),
      makeOffline: (n) => void this.runSync(n, true),
      freeUp: (n) => void this.runSync(n, false),
      cancel: (n) => {
        const active = this.syncingAncestor(n.path);
        if (active) this.cancelTokens.get(active)?.cancel();
      },
    };
    const modal = new SyncDetailsModal(this.app, node, ctl, () => {
      if (this.details === modal) this.details = undefined;
    });
    this.details = modal;
    modal.open();
  }

  /** Clic droit (ordinateur) ou appui long (mobile) sur une ligne → détails. L'appui long
   *  annule le toucher qui suit, pour ne pas aussi déplier le dossier. */
  private bindDetails(row: HTMLElement, node: TreeNode): void {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openDetails(node);
    });
    let timer: number | undefined;
    let fired = false;
    let x = 0;
    let y = 0;
    const cancel = () => window.clearTimeout(timer);
    row.addEventListener('touchstart', (e) => {
      fired = false;
      x = e.touches[0].clientX;
      y = e.touches[0].clientY;
      timer = window.setTimeout(() => {
        fired = true;
        this.openDetails(node);
      }, 500);
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      if (Math.hypot(e.touches[0].clientX - x, e.touches[0].clientY - y) > 10) cancel();
    }, { passive: true });
    row.addEventListener('touchend', (e) => {
      cancel();
      if (fired) e.preventDefault();
    });
    row.addEventListener('touchcancel', cancel);
  }

  /** `parentDriveId` = id Drive RÉEL du dossier parent (pour téléverser un enfant local-only),
   *  ou null si le parent est lui-même local-only (pas encore sur Drive). */
  private async renderNode(out: HTMLElement, node: TreeNode, depth: number, parentDriveId: string | null): Promise<void> {
    if (node.localOnly) return this.renderLocalOnlyNode(out, node, depth, parentDriveId);

    const row = out.createDiv({ cls: 'gdrive-fod-row' });
    row.style.paddingLeft = `${depth * 16}px`;

    if (node.isFolder) await this.reconcile(node);
    const status = this.status(node);
    if (status.kind === 'syncing') {
      row.createSpan({ cls: 'gdrive-fod-spinner' });
      // pourcentage sur la ligne qui porte la sync (pas sur tout le sous-arbre)
      const prog = status.progress;
      if (prog && prog.total > 0) {
        row.createSpan({ cls: 'gdrive-fod-progress', text: `${Math.round((prog.done / prog.total) * 100)} %` });
      }
    } else if (node.isFolder) {
      // Dossier : pastille d'état (verte = synchronisé, pointillés = partiel, noire = non) ;
      // la toucher synchronise tout, ou libère l'espace si tout l'est déjà.
      const synced = status.kind === 'offline';
      const pill = row.createSpan({ cls: 'gdrive-fod-pill' });
      pill.dataset.state = status.kind;
      setIcon(pill, status.kind === 'online' ? 'x' : 'check');
      pill.setAttr('role', 'button');
      pill.setAttr('aria-label', synced ? t('details.freeUp') : t('details.makeOffline'));
      pill.onclick = (e) => {
        e.stopPropagation();
        void this.runSync(node, !synced);
      };
    } else {
      const checked = status.kind === 'offline';
      const cb = row.createSpan({ cls: 'gdrive-fod-check' });
      cb.dataset.state = checked ? 'checked' : 'unchecked';
      if (checked) setIcon(cb, 'check');
      cb.setAttr('role', 'checkbox');
      cb.setAttr('aria-checked', checked ? 'true' : 'false');
      cb.setAttr('aria-label', checked ? t('details.freeUp') : t('details.makeOffline'));
      cb.onclick = (e) => {
        e.stopPropagation();
        void this.runSync(node, !checked);
      };
    }

    const icon = row.createSpan({ cls: 'gdrive-fod-icon' });
    setIcon(icon, node.isFolder ? (this.model.isExpanded(node.path) ? 'chevron-down' : 'chevron-right') : 'file');
    row.createSpan({ cls: 'gdrive-fod-name', text: ' ' + node.name });

    // Icône d'état, seulement quand il faut agir : échec, ou annuler une sync en cours.
    const badgeIcon = status.failed.length > 0 ? 'alert-circle' : status.kind === 'syncing' && this.syncing.has(node.path) ? 'x' : null;
    if (badgeIcon) {
      const badge = row.createSpan({ cls: `gdrive-fod-badge${status.failed.length > 0 ? ' is-error' : ''}` });
      setIcon(badge, badgeIcon);
      badge.setAttr('role', 'button');
      const cancels = badgeIcon === 'x';
      badge.setAttr('aria-label', cancels ? t('details.cancel') : t('details.open'));
      badge.onclick = (e) => {
        e.stopPropagation();
        if (cancels) {
          const active = this.syncingAncestor(node.path);
          if (active) this.cancelTokens.get(active)?.cancel();
        } else {
          this.openDetails(node);
        }
      };
    }
    this.bindDetails(row, node);

    if (node.isFolder) {
      row.onclick = async () => {
        this.model.toggle(node.path);
        await this.render();
      };
      if (this.model.isExpanded(node.path)) {
        const children = await this.model.loadChildren(node.id, node.path);
        for (const c of children) await this.renderNode(out, c, depth + 1, node.id); // parent Drive réel
      }
    }
  }

  /** Nœud « local-only » : existe en local, pas sur Drive → grisé, case = téléverser (↑).
   *  Téléversable seulement si le parent est un vrai dossier Drive (parentDriveId non null). */
  private async renderLocalOnlyNode(out: HTMLElement, node: TreeNode, depth: number, parentDriveId: string | null): Promise<void> {
    const row = out.createDiv({ cls: 'gdrive-fod-row gdrive-fod-local' });
    row.style.paddingLeft = `${depth * 16}px`;

    if (this.syncingAncestor(node.path)) {
      row.createSpan({ cls: 'gdrive-fod-spinner' });
    } else if (parentDriveId) {
      const cb = row.createSpan({ cls: 'gdrive-fod-check gdrive-fod-upload' });
      cb.setAttr('role', 'button');
      cb.setAttr('aria-label', t('panel.uploadAria'));
      cb.onclick = async (e) => {
        e.stopPropagation();
        this.syncing.add(node.path);
        await this.render();
        try {
          await this.create.uploadLocal(node.path, node.isFolder, parentDriveId);
          this.model.invalidate(parentDriveId); // le fichier est maintenant sur Drive
        } catch (err) {
          new Notice(t('panel.errorSync', { error: String(err) }));
        } finally {
          this.syncing.delete(node.path);
          await this.render();
        }
      };
    } else {
      // à l'intérieur d'un dossier local-only : on téléverse le dossier parent en entier
      row.createSpan({ cls: 'gdrive-fod-check gdrive-fod-upload is-disabled' });
    }

    const icon = row.createSpan({ cls: 'gdrive-fod-icon' });
    setIcon(icon, node.isFolder ? (this.model.isExpanded(node.path) ? 'chevron-down' : 'chevron-right') : 'file');
    row.createSpan({ text: ' ' + node.name });

    if (node.isFolder) {
      row.onclick = async () => {
        this.model.toggle(node.path);
        await this.render();
      };
      if (this.model.isExpanded(node.path)) {
        const children = await this.model.loadChildren(node.id, node.path); // id `local:` → enfants locaux
        for (const c of children) await this.renderNode(out, c, depth + 1, null); // pas de parent Drive réel
      }
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
