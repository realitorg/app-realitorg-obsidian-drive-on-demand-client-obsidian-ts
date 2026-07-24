import { Plugin, Notice, TFile, TFolder, type TAbstractFile, MarkdownView, setIcon } from 'obsidian';
import { obsidianHttp } from './http';
import { genId } from './auth/state';
import { buildConsentUrl } from './auth/oauth-url';
import { TokenStore } from './auth/token-store';
import { ObsidianDriveAuth } from './auth/drive-auth';
import { ByoCredentialsStore } from './auth/byo-store';
import { exchangeCodeForTokens, type AppCredentials } from './auth/google-oauth';
import { PluginDataStore, keyedAdapter } from './plugin-data';
import { DriveClient } from './drive/drive-client';
import { MirrorIndex } from './mirror/mirror-index';
import { ObsidianVaultOps } from './mirror/vault-ops';
import { Hydrator, type HydrateResult } from './mirror/hydrator';
import { DriveTreeModel, type TreeNode } from './panel/tree-model';
import { DriveTreeView, VIEW_TYPE } from './panel/tree-view';
import { SelectiveSyncState } from './panel/selective-sync-state';
import { WorkingRootStore } from './panel/working-root';
import { OutboxStore } from './panel/outbox';
import { SyncScheduler } from './panel/sync-scheduler';
import { RemoteChangeSync } from './panel/remote-change-sync';
import { toNfc } from './util/nfc';
import { SyncEngine } from './panel/sync-engine';
import { PushManager } from './panel/push-manager';
import { PullManager } from './panel/pull-manager';
import { CreateManager } from './panel/create-manager';
import { DriveOnDemandSettingTab } from './settings-tab';
import { t } from './i18n';

const BROKER = 'https://obsidian-drive-on-demand.solutions.real-it.org';
const CLIENT_ID = '509417959184-8l37q9bk12kp7t5kbj8s0ar516dr8unb.apps.googleusercontent.com'; // public (pas le secret)
const SCOPE = 'https://www.googleapis.com/auth/drive';
/** Redirect BYO : page de rebond du broker qui renvoie le `code` brut vers obsidian://
 *  (sans échange — le broker ne détient pas le secret de l'utilisateur). */
const BYO_REDIRECT = `${BROKER}/callback-byo`;

export default class GoogleDriveFodPlugin extends Plugin {
  private auth!: ObsidianDriveAuth;
  private pendingState: string | null = null;
  private data!: PluginDataStore;
  private index!: MirrorIndex;
  private hydrator!: Hydrator;
  private drive!: DriveClient;
  /** Vues note ayant déjà reçu le bouton « synchroniser cette note » (évite les doublons). */
  private syncActionViews = new WeakSet<MarkdownView>();
  /** Connexion OAuth déclenchée depuis les réglages (pas de commande). */
  private startAuthFn!: () => void;
  /** Store + copie mémoire (accès synchrone) des identifiants BYO de l'utilisateur. */
  private byoStore!: ByoCredentialsStore;
  private byoConfig: AppCredentials | null = null;
  /** Sync manuelle complète déclenchée depuis les réglages (« Synchroniser maintenant »). */
  private refreshAllFn!: () => Promise<void>;

  async onload(): Promise<void> {
    this.data = new PluginDataStore(
      async () => ((await this.loadData()) ?? {}) as Record<string, unknown>,
      async (d) => { await this.saveData(d); },
    );
    await this.data.init();

    const tokenStore = new TokenStore(keyedAdapter(this.data, 'rt'));
    this.byoStore = new ByoCredentialsStore(keyedAdapter(this.data, 'byo'));
    this.byoConfig = await this.byoStore.get();
    this.auth = new ObsidianDriveAuth({
      http: obsidianHttp, store: tokenStore, brokerBase: BROKER,
      byoCredentials: () => this.byoConfig,
    });

    this.drive = new DriveClient(obsidianHttp, () => this.auth.getAccessToken(), 'root');
    this.index = new MirrorIndex(keyedAdapter(this.data, 'mirror'));
    await this.index.load();
    const pluginCreated = new Set<string>();
    const vaultOps = new ObsidianVaultOps(this.app.vault, (p) => pluginCreated.add(p));
    this.hydrator = new Hydrator(vaultOps, this.index, this.drive);

    const model = new DriveTreeModel(
      this.drive,
      keyedAdapter(this.data, 'treeCache'),
      undefined,
      (p) => vaultOps.listChildren(p), // fichiers locaux absents de Drive → affichés grisés
    );
    await model.load();

    const syncState = new SelectiveSyncState(keyedAdapter(this.data, 'sync'));
    await syncState.load();
    const workingRoot = new WorkingRootStore(keyedAdapter(this.data, 'workingRoot'));
    await workingRoot.load();
    const engine = new SyncEngine(vaultOps, this.index, this.hydrator, this.drive, syncState);

    const conflictNotice = (path: string, cp: string) =>
      new Notice(t('main.conflict', { path, conflictPath: cp }));

    // Status bar : UNIQUE témoin de l'état, mis à jour en continu. Icône colorée seule
    // (spinner = synchronisation en cours ; vert = en ligne ; rouge = hors ligne), tooltip
    // court traduit. Connectivité suivie par les événements réseau + un poll de secours (5 s).
    const statusEl = this.addStatusBarItem();
    statusEl.addClass('gdrive-fod-status');
    let syncing = false;
    let online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    let lastKind: 'busy' | 'ok' | 'error' | null = null;
    const renderStatus = () => {
      const kind: 'busy' | 'ok' | 'error' = syncing ? 'busy' : online ? 'ok' : 'error';
      if (kind === lastKind) return; // évite le clignotement au poll
      lastKind = kind;
      statusEl.empty();
      statusEl.removeClasses(['is-ok', 'is-error', 'is-busy']);
      const icon = kind === 'busy' ? 'refresh-cw' : kind === 'error' ? 'cloud-off' : 'cloud';
      const labelKey = kind === 'busy' ? 'status.syncing' : kind === 'error' ? 'status.offline' : 'status.online';
      setIcon(statusEl, icon);
      statusEl.addClass(kind === 'busy' ? 'is-busy' : kind === 'error' ? 'is-error' : 'is-ok');
      statusEl.setAttr('aria-label', t(labelKey));
    };
    const setSyncing = (v: boolean) => { syncing = v; renderStatus(); };
    const setOnline = (v: boolean) => { online = v; renderStatus(); };
    renderStatus();
    // synchronisation en cours → laissée prioritaire (spinner) ; sinon on/offline
    const setStatus = (kind: 'busy' | 'ok' | 'error') => setSyncing(kind === 'busy');
    // connectivité : événements instantanés + poll de secours toutes les 5 s
    this.registerDomEvent(window, 'online', () => setOnline(true));
    this.registerDomEvent(window, 'offline', () => setOnline(false));
    this.registerInterval(
      window.setInterval(() => setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true), 5000),
    );

    const outbox = new OutboxStore(keyedAdapter(this.data, 'outbox'));
    await outbox.load();

    const push = new PushManager({
      vault: vaultOps,
      drive: this.drive,
      index: this.index,
      state: syncState,
      outbox,
      onError: (path, err) => { setStatus('error'); new Notice(t('main.pushError', { path, error: String(err) })); },
      onConflict: conflictNotice,
      onStatus: setStatus,
    });
    this.registerEvent(this.app.vault.on('modify', (file) => push.onModify(toNfc(file.path))));
    this.register(() => push.dispose());

    const pull = new PullManager({ vault: vaultOps, drive: this.drive, index: this.index, state: syncState, onConflict: conflictNotice, onStatus: setStatus });

    // Synchronisation périodique CIBLÉE (5 s) : renvoie le livret (local→Drive) + rafraîchit
    // uniquement les notes OUVERTES (Drive→local), pour qu'une note affichée reflète une
    // édition faite ailleurs. Pausée hors-ligne ; rattrapage immédiat au retour en ligne.
    const getOpenPaths = (): string[] => {
      const set = new Set<string>();
      this.app.workspace.iterateAllLeaves((leaf) => {
        const file = (leaf.view as { file?: { path?: string } }).file;
        if (file?.path) set.add(toNfc(file.path));
      });
      return [...set];
    };
    // Re-synchronise UN dossier full-sync : matérialise les fichiers/sous-dossiers apparus sur
    // Drive depuis la dernière fois (idempotent — ne touche jamais un fichier déjà présent en local).
    const resyncFolder = async (folderPath: string): Promise<string[]> => {
      const entry = this.index.get(folderPath);
      if (!entry?.driveId) return [];
      const name = folderPath.split('/').pop() ?? folderPath;
      const folderNode: TreeNode = {
        id: entry.driveId, name, path: folderPath, isFolder: true,
        meta: { id: entry.driveId, name, mimeType: entry.mimeType, modifiedTime: entry.modifiedTime ?? '' },
      };
      const plan = await engine.planFolderSync(folderNode);
      const res = await engine.applyFolderSync(folderNode, plan);
      return res.failed;
    };

    // Balayage complet (~60 s) : répercute en local les renommages / déplacements / contenu
    // faits sur Drive pour TOUS les fichiers synchronisés ; et matérialise les NOUVEAUX fichiers
    // apparus dans un dossier synchronisé en entier (full-sync).
    const remoteSync = new RemoteChangeSync({
      drive: this.drive, index: this.index, state: syncState, vault: vaultOps, pull,
      rootId: () => workingRoot.rootId(),
      adapter: keyedAdapter(this.data, 'scheduler'),
      onRename: (o, n) => console.log('[gdrive-fod] renommage distant', o, '→', n),
      resyncFullFolder: async (folderPath) => {
        try { await resyncFolder(folderPath); }
        catch (e) { console.error('[gdrive-fod] re-sync dossier (nouveau fichier)', folderPath, e); }
      },
    });
    await remoteSync.load();

    const scheduler = new SyncScheduler({
      pull, push,
      getOpenPaths,
      isSynced: (p) => syncState.isSynced(p),
      isOnline: () => online,
      intervalMs: 5000,
      fullScan: () => remoteSync.scan(),
      fullScanEvery: 12, // ~60 s
      onError: (e) => console.error('[gdrive-fod] tick de synchronisation', e),
    });
    this.register(() => scheduler.dispose());
    // au retour en ligne : rattrapage immédiat (en plus de setOnline dans le bloc statut)
    this.registerDomEvent(window, 'online', () => void scheduler.tick());
    this.app.workspace.onLayoutReady(() => scheduler.start());

    // Bouton « synchroniser cette note » dans l'en-tête de chaque note ouverte (mobile inclus).
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && !this.syncActionViews.has(view)) {
          this.syncActionViews.add(view);
          view.addAction('refresh-cw', t('action.syncNote'), () => {
            const file = view.file;
            if (!file) return;
            void this.syncOneNote(pull, push, syncState, toNfc(file.path), setStatus);
          });
        }
      }),
    );

    const create = new CreateManager({
      index: this.index, drive: this.drive, vault: vaultOps, state: syncState,
      wasPluginCreated: (p) => pluginCreated.delete(p),
    });
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          void create.handleCreate(toNfc(file.path), file instanceof TFolder).catch((e) => new Notice(t('main.createError', { error: String(e) })));
        }),
      );
      // Déplacement / renommage local (glisser un fichier dans un dossier synchronisé, etc.)
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          void this.handleLocalRename(create, file, oldPath).catch((e) => new Notice(t('main.createError', { error: String(e) })));
        }),
      );
    });

    this.registerView(VIEW_TYPE, (leaf) => new DriveTreeView(leaf, model, syncState, engine, this.drive, workingRoot, create));
    this.addRibbonIcon('cloud', t('ribbon.googleDrive'), () => void this.activateDriveView());

    this.registerObsidianProtocolHandler('google-drive-fod-auth', async (params) => {
      if (params.error) {
        if (params.state === this.pendingState) this.pendingState = null;
        new Notice(t('main.authCancelled', { error: params.error }));
        return;
      }
      if (params.state !== this.pendingState) {
        new Notice(t('main.invalidCallback'));
        return;
      }
      this.pendingState = null;
      try {
        // Mode BYO : le broker a rebondi le `code` brut → on l'échange DIRECTEMENT chez Google
        // avec les identifiants de l'utilisateur (le broker n'a jamais vu son secret).
        if (params.code && this.byoConfig) {
          const tokens = await exchangeCodeForTokens(obsidianHttp, params.code, { ...this.byoConfig, redirectUri: BYO_REDIRECT });
          if (!tokens.refreshToken) { new Notice(t('main.tokenFetchFailed')); return; }
          await this.auth.setRefreshFromClaim(tokens.refreshToken);
          setStatus('ok');
          return;
        }
        // Mode managé : le broker a déjà échangé le code et stocké le refresh sous un pairing.
        if (!params.pairing) { new Notice(t('main.invalidCallback')); return; }
        const res = await obsidianHttp({ url: `${BROKER}/claim?pairing=${encodeURIComponent(params.pairing)}` });
        if (res.status !== 200) { new Notice(t('main.tokenFetchFailed')); return; }
        const { refresh_token } = res.json<{ refresh_token: string }>();
        await this.auth.setRefreshFromClaim(refresh_token);
        setStatus('ok');
      } catch (e) {
        new Notice(t('main.claimError', { error: String(e) }));
      }
    });

    // Connexion OAuth : déclenchée depuis l'onglet de réglages (plus de commande).
    // Mode BYO → identifiants + redirect de l'utilisateur ; sinon → broker managé Real-IT.
    this.startAuthFn = () => {
      this.pendingState = genId(16);
      const url = this.byoConfig
        ? buildConsentUrl({ clientId: this.byoConfig.clientId, redirectUri: BYO_REDIRECT, scope: SCOPE, state: this.pendingState })
        : buildConsentUrl({ clientId: CLIENT_ID, redirectUri: `${BROKER}/callback`, scope: SCOPE, state: this.pendingState });
      window.open(url, '_blank');
    };

    // « Synchroniser maintenant » (réglages) : rafraîchit les fichiers synchronisés puis
    // re-scanne les dossiers « complets » pour découvrir les nouveaux fichiers ajoutés côté
    // Drive — sûr et idempotent (applyFolderSync ne touche jamais un fichier déjà présent).
    this.refreshAllFn = async () => {
      const r = await pull.refreshAllSynced();
      const allFull = syncState.allFullFolders();
      const topLevelFull = allFull.filter(
        (p) => !allFull.some((other) => other !== p && p.startsWith(`${other}/`)),
      );
      const allFailed: string[] = [];
      for (const folderPath of topLevelFull) {
        try {
          allFailed.push(...await resyncFolder(folderPath));
        } catch (e) {
          console.error('[gdrive-fod] échec re-scan dossier', folderPath, e);
        }
      }
      if (r.conflicts > 0) new Notice(t('main.refreshSummary', { pulled: r.pulled, conflicts: r.conflicts }));
      if (allFailed.length > 0) new Notice(t('panel.someFilesFailed', { count: allFailed.length }));
    };

    this.addSettingTab(new DriveOnDemandSettingTab(this.app, this));

    const messageKeys: Record<HydrateResult, string | null> = {
      hydrated: null,
      already: null,
      'not-mirrored': null,
      folder: null,
      'google-native': 'main.googleNative',
    };
    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        if (!file) return;
        const path = toNfc(file.path);
        try {
          const result = await this.hydrator.hydrate(path);
          const msgKey = messageKeys[result];
          if (msgKey) new Notice(t(msgKey));
          if (syncState.isSynced(path)) {
            await pull.refreshFile(path);
          }
        } catch (e) {
          setStatus('error');
          new Notice(t('main.hydrationError', { error: String(e) }));
        }
      }),
    );
  }

  /** Déplacement/renommage local → Drive. Un dossier déplacé DANS une zone synchronisée
   *  ne génère qu'un seul événement `rename` (pas un par enfant) : on énumère donc ses
   *  fichiers pour les synchroniser (no-op si déjà suivis, ex. dossier déjà synchronisé). */
  private async handleLocalRename(create: CreateManager, file: TAbstractFile, oldPath: string): Promise<void> {
    const isFolder = file instanceof TFolder;
    await create.handleRename(toNfc(oldPath), toNfc(file.path), isFolder);
    if (isFolder) {
      const files: TFile[] = [];
      const walk = (f: TAbstractFile): void => {
        if (f instanceof TFolder) f.children.forEach(walk);
        else if (f instanceof TFile) files.push(f);
      };
      file.children.forEach(walk);
      for (const child of files) await create.handleCreate(toNfc(child.path), false);
    }
  }

  /** Synchronise UNE note (bouton dans l'en-tête) : tire le distant (avec gestion de conflit)
   *  puis pousse le local. Feedback via la status bar + une notification. */
  private async syncOneNote(
    pull: PullManager,
    push: PushManager,
    state: SelectiveSyncState,
    path: string,
    setStatus: (kind: 'busy' | 'ok' | 'error') => void,
  ): Promise<void> {
    if (!state.isSynced(path)) {
      new Notice(t('action.notSynced'));
      return;
    }
    setStatus('busy');
    try {
      await pull.refreshFile(path); // Drive → local
      await push.flush(path); // local → Drive
      setStatus('ok');
      new Notice(t('action.synced'));
    } catch (e) {
      setStatus('error');
      new Notice(t('action.syncError', { error: String(e) }));
    }
  }

  // --- API publique pour l'onglet de réglages ---

  /** Un compte Google est-il connecté ? */
  isConnected(): Promise<boolean> {
    return this.auth.isConnected();
  }

  /** Email du compte connecté (peut échouer si hors-ligne). */
  async accountEmail(): Promise<string | undefined> {
    return (await this.drive.aboutUser()).email;
  }

  /** Déconnecte le compte (oublie le refresh token). */
  disconnect(): Promise<void> {
    return this.auth.disconnect();
  }

  /** Lance la connexion OAuth Google (ouvre le navigateur). */
  startAuth(): void {
    this.startAuthFn();
  }

  /** Identifiants BYO actuellement configurés (mode avancé), ou null (mode broker). */
  getByoConfig(): AppCredentials | null {
    return this.byoConfig;
  }

  /** Enregistre des identifiants BYO. Change de projet Google → on oublie l'ancienne
   *  session (refresh token de l'ancien projet devenu invalide) : reconnexion nécessaire. */
  async setByoConfig(creds: AppCredentials): Promise<void> {
    await this.byoStore.set(creds);
    this.byoConfig = await this.byoStore.get();
    await this.auth.disconnect();
  }

  /** Repasse en mode broker managé (oublie les identifiants BYO + la session). */
  async clearByoConfig(): Promise<void> {
    await this.byoStore.clear();
    this.byoConfig = null;
    await this.auth.disconnect();
  }

  /** URI de redirection à enregistrer dans le projet Google Cloud de l'utilisateur (BYO). */
  byoRedirectUri(): string {
    return BYO_REDIRECT;
  }

  /** Ouvre le panneau explorateur Drive. */
  openPanel(): Promise<void> {
    return this.activateDriveView();
  }

  /** Synchronisation manuelle complète (« Synchroniser maintenant »). */
  syncNow(): Promise<void> {
    return this.refreshAllFn();
  }

  private async activateDriveView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: VIEW_TYPE, active: true });
      leaf = right;
    }
    void workspace.revealLeaf(leaf);
  }
}
