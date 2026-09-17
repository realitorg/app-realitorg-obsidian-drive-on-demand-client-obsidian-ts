import * as obsidian from 'obsidian';

export type Lang = 'fr' | 'en';

/**
 * Langue réglée dans Obsidian, lue par l'API du plugin et non dans le stockage local
 * du navigateur : `getLanguage` à partir de 1.8.7, sinon la locale de moment, qu'Obsidian
 * aligne sur la même langue.
 */
function readObsidianLanguage(): string | null {
  try {
    const api = obsidian as { getLanguage?: () => string; moment?: { locale(): string } };
    if (typeof api.getLanguage === 'function') return api.getLanguage();
    if (typeof api.moment?.locale === 'function') return api.moment.locale();
  } catch {
    /* module obsidian indisponible (ex. tests) */
  }
  return null;
}

function readBrowserLanguage(): string | null {
  try {
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.language) {
      return navigator.language;
    }
  } catch {
    /* environnement sans window/navigator (ex. tests Node) */
  }
  return null;
}

/** Langue d'Obsidian (réglages > Général > Langue), repli navigateur, puis anglais par défaut. */
export function detectLang(): Lang {
  const raw = readObsidianLanguage() ?? readBrowserLanguage() ?? 'en';
  return raw.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

let currentLang: Lang = detectLang();

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

type Dict = Record<string, string>;

const FR: Dict = {
  'ribbon.googleDrive': "Drive on Demand",
  'settings.accountName': "Compte Google",
  'settings.accountChecking': "Vérification…",
  'settings.accountNotConnected': "Aucun compte connecté.",
  'settings.accountConnected': "Connecté : {email}",
  'settings.accountConnectedNoEmail': "Connecté.",
  'settings.connect': "Connecter mon compte",
  'settings.connectStarted': "Ouverture de la connexion Google dans le navigateur…",
  'settings.connectedOk': "Compte Google connecté.",
  'settings.disconnect': "Déconnecter",
  'settings.disconnected': "Compte déconnecté.",
  'settings.openPanelName': "Panneau Drive",
  'settings.openPanelDesc': "Ouvrir l'explorateur de fichiers Drive on Demand.",
  'settings.openPanel': "Ouvrir le panneau",
  'settings.syncNowName': "Synchroniser maintenant",
  'settings.syncNowDesc': "Rafraîchit les fichiers synchronisés et redécouvre les nouveautés côté Drive.",
  'settings.syncNow': "Synchroniser",
  'settings.syncNowDone': "Synchronisation terminée.",
  'settings.syncNowError': "Erreur de synchronisation : {error}",
  'settings.cancel': "Annuler",
  'settings.cancelled': "Opération annulée.",
  'settings.workingRootName': "Dossier de travail",
  'settings.workingRootDesc': "Le dossier Drive utilisé comme racine. Actuel : {current}",
  'settings.workingRootChange': "Changer",
  'settings.vaultHeading': "Réglages du vault",
  'settings.vaultDesc': "Ce plugin et la disposition des panneaux sont toujours exclus.",
  'settings.vaultPushName': "Téléverser mes réglages",
  'settings.vaultPushDesc': "Envoie les réglages de CET appareil vers Drive (écrase la version distante).",
  'settings.vaultPush': "Téléverser",
  'settings.vaultPushDone': "Réglages téléversés : {created} créé(s), {updated} mis à jour.",
  'settings.vaultPullName': "Tirer les réglages",
  'settings.vaultPullDesc': "Récupère les réglages depuis Drive (écrase ceux de cet appareil).",
  'settings.vaultPull': "Tirer",
  'settings.vaultPullDone': "{pulled} fichier(s) de réglages récupéré(s) — redémarrez Obsidian pour les appliquer.",
  'settings.vaultPullAbsent': "Aucun réglage trouvé sur Drive. Téléversez-les d'abord depuis un appareil.",
  'settings.vaultPullConfirm': "Écraser les réglages de cet appareil par ceux de Drive ? Obsidian devra être redémarré.",
  'settings.vaultPushConfirm': "Écraser les réglages présents sur Drive par ceux de cet appareil ?",
  'settings.vaultError': "Erreur sur les réglages : {error}",
  'settings.modeName': "Mode de connexion",
  'settings.modeDefault': "Par défaut",
  'settings.modeSelfHosted': "Auto-hébergé",
  'settings.selfHostedDesc': "Utilisez votre propre projet Google Cloud (voir la documentation pour le créer).",
  'settings.unsaved': "Modifications non enregistrées",
  'settings.save': "Enregistrer",
  'settings.saved': "Réglages enregistrés.",
  'settings.modeHeading': "Mode de synchronisation",
  'settings.byoDesc': "Utilisez votre propre projet Google Cloud pour plus de contrôle. Le secret ne transite jamais par nos serveurs.",
  'settings.byoStatusManaged': "Mode par défaut activé.",
  'settings.byoStatusActive': "Mode auto-hébergé activé — votre projet ({clientId}).",
  'settings.byoRedirectLabel': "URI de redirection à autoriser",
  'settings.byoRedirectDesc': "Dans votre client OAuth Google Cloud (type « Web »), ajoutez exactement cette URI de redirection autorisée :",
  'settings.byoClientId': "Client ID",
  'settings.byoClientSecret': "Client secret",
  'settings.byoClientSecretPlaceholder': "Collez votre client secret",
  'settings.byoSave': "Enregistrer et activer",
  'settings.byoSaved': "Identifiants enregistrés — reconnectez votre compte via « Connecter mon compte ».",
  'settings.byoMissing': "Renseignez le client ID et le client secret.",
  'settings.byoClear': "Revenir au mode géré (Real-IT)",
  'settings.byoCleared': "Retour au mode géré — reconnectez votre compte.",
  'panel.title': "Drive on Demand",
  'panel.refreshButton': "Rafraîchir",
  'panel.notConnected': "Non connecté — connecte ton compte dans les réglages du plugin.",
  'panel.error': "Erreur : {error}",
  'panel.cancelAria': "Annuler",
  'panel.errorSync': "Erreur sync : {error}",
  'panel.someFilesFailed': "{count} fichier(s) n'ont pas pu être synchronisé(s) — réessaie plus tard.",
  'panel.pickFolderAria': "Choisir le dossier de travail",
  'panel.uploadAria': "Téléverser vers Drive",
  'action.syncNote': "Synchroniser cette note",
  'action.notSynced': "Cette note n'est pas synchronisée.",
  'action.synced': "Note synchronisée.",
  'action.syncError': "Erreur de synchronisation : {error}",
  'status.online': "En ligne",
  'status.offline': "Hors ligne",
  'status.syncing': "Synchronisation…",
  'panel.workingRootChanged': "Dossier de travail : {name}",
  'panel.workingRootReset': "Dossier de travail : racine du Drive",
  'picker.title': "Choisir le dossier de travail",
  'picker.driveRoot': "Racine du Drive",
  'picker.chooseThisFolder': "Choisir ce dossier",
  'picker.cancel': "Annuler",
  'picker.loading': "Chargement…",
  'picker.noSubfolder': "Aucun sous-dossier ici.",
  'picker.error': "Erreur : {error}",
  'picker.offline': "Hors ligne — impossible de parcourir les dossiers pour l'instant. Reconnecte-toi à Internet et réessaie.",
  'picker.notConnected': "Non connecté — connecte ton compte dans les réglages du plugin.",
  'picker.switchConfirm': "{count} fichier(s) synchronisé(s) depuis le dossier actuel seront retirés du vault (ils restent sur Drive). Changer de dossier de travail ?",
  'main.conflict': "Conflit sur « {path} » — version distante gardée dans « {conflictPath} »",
  'main.pushError': "Échec sync « {path} » : {error}",
  'main.createError': "Erreur création Drive : {error}",
  'main.authCancelled': "Connexion Google annulée : {error}",
  'main.invalidCallback': "Callback OAuth invalide (state).",
  'main.tokenFetchFailed': "Échec récupération du token.",
  'main.claimError': "Erreur claim : {error}",
  'main.rootListed': "Racine Drive : {count} éléments (voir console)",
  'main.notConnectedFirst': "Non connecté — connecte ton compte dans les réglages du plugin.",
  'main.genericError': "Erreur : {error}",
  'main.refreshSummary': "Rafraîchi : {pulled} mis à jour, {conflicts} conflit(s).",
  'main.refreshError': "Erreur refresh : {error}",
  'main.googleNative': "Fichier Google natif (Docs/Sheets/Slides) — ouvrez la note-lien .md pour y accéder.",
  'main.hydrationError': "Erreur hydratation : {error}",
};

const EN: Dict = {
  'ribbon.googleDrive': "Drive on Demand",
  'settings.accountName': "Google account",
  'settings.accountChecking': "Checking…",
  'settings.accountNotConnected': "No account connected.",
  'settings.accountConnected': "Connected: {email}",
  'settings.accountConnectedNoEmail': "Connected.",
  'settings.connect': "Connect my account",
  'settings.connectStarted': "Opening Google sign-in in your browser…",
  'settings.connectedOk': "Google account connected.",
  'settings.disconnect': "Disconnect",
  'settings.disconnected': "Account disconnected.",
  'settings.openPanelName': "Drive panel",
  'settings.openPanelDesc': "Open the Drive on Demand file explorer.",
  'settings.openPanel': "Open panel",
  'settings.syncNowName': "Sync now",
  'settings.syncNowDesc': "Refreshes synced files and rediscovers new files on Drive.",
  'settings.syncNow': "Sync",
  'settings.syncNowDone': "Sync complete.",
  'settings.syncNowError': "Sync error: {error}",
  'settings.cancel': "Cancel",
  'settings.cancelled': "Operation cancelled.",
  'settings.workingRootName': "Working folder",
  'settings.workingRootDesc': "The Drive folder used as root. Current: {current}",
  'settings.workingRootChange': "Change",
  'settings.vaultHeading': "Vault settings",
  'settings.vaultDesc': "This plugin and pane layout are always excluded.",
  'settings.vaultPushName': "Upload my settings",
  'settings.vaultPushDesc': "Sends THIS device's settings to Drive (overwrites the remote version).",
  'settings.vaultPush': "Upload",
  'settings.vaultPushDone': "Settings uploaded: {created} created, {updated} updated.",
  'settings.vaultPullName': "Pull settings",
  'settings.vaultPullDesc': "Fetches settings from Drive (overwrites this device's).",
  'settings.vaultPull': "Pull",
  'settings.vaultPullDone': "{pulled} settings file(s) pulled — restart Obsidian to apply them.",
  'settings.vaultPullAbsent': "No settings found on Drive. Upload them from a device first.",
  'settings.vaultPullConfirm': "Overwrite this device's settings with the ones from Drive? Obsidian will need a restart.",
  'settings.vaultPushConfirm': "Overwrite the settings stored on Drive with this device's?",
  'settings.vaultError': "Vault settings error: {error}",
  'settings.modeName': "Connection mode",
  'settings.modeDefault': "Default",
  'settings.modeSelfHosted': "Self-hosted",
  'settings.selfHostedDesc': "Use your own Google Cloud project (see the documentation to create it).",
  'settings.unsaved': "Unsaved changes",
  'settings.save': "Save",
  'settings.saved': "Settings saved.",
  'settings.modeHeading': "Sync mode",
  'settings.byoDesc': "Use your own Google Cloud project for full control. Your secret never passes through our servers.",
  'settings.byoStatusManaged': "Default mode enabled.",
  'settings.byoStatusActive': "Self-hosted mode enabled — your project ({clientId}).",
  'settings.byoRedirectLabel': "Authorized redirect URI",
  'settings.byoRedirectDesc': "In your Google Cloud OAuth client (type \"Web\"), add exactly this authorized redirect URI:",
  'settings.byoClientId': "Client ID",
  'settings.byoClientSecret': "Client secret",
  'settings.byoClientSecretPlaceholder': "Paste your client secret",
  'settings.byoSave': "Save and enable",
  'settings.byoSaved': "Credentials saved — reconnect your account via \"Connect my account\".",
  'settings.byoMissing': "Enter both the client ID and the client secret.",
  'settings.byoClear': "Back to managed mode (Real-IT)",
  'settings.byoCleared': "Back to managed mode — reconnect your account.",
  'panel.title': "Drive on Demand",
  'panel.refreshButton': "Refresh",
  'panel.notConnected': "Not connected — connect your account in the plugin settings.",
  'panel.error': "Error: {error}",
  'panel.cancelAria': "Cancel",
  'panel.errorSync': "Sync error: {error}",
  'panel.someFilesFailed': "{count} file(s) could not be synced — try again later.",
  'panel.pickFolderAria': "Choose working folder",
  'panel.uploadAria': "Upload to Drive",
  'action.syncNote': "Sync this note",
  'action.notSynced': "This note isn't synced.",
  'action.synced': "Note synced.",
  'action.syncError': "Sync error: {error}",
  'status.online': "Online",
  'status.offline': "Offline",
  'status.syncing': "Syncing…",
  'panel.workingRootChanged': "Working folder: {name}",
  'panel.workingRootReset': "Working folder: Drive root",
  'picker.title': "Choose working folder",
  'picker.driveRoot': "Drive root",
  'picker.chooseThisFolder': "Choose this folder",
  'picker.cancel': "Cancel",
  'picker.loading': "Loading…",
  'picker.noSubfolder': "No subfolder here.",
  'picker.error': "Error: {error}",
  'picker.offline': "Offline — can't browse folders right now. Reconnect to the internet and try again.",
  'picker.notConnected': "Not connected — connect your account in the plugin settings.",
  'picker.switchConfirm': "{count} file(s) synced from the current folder will be removed from the vault (they remain on Drive). Change working folder?",
  'main.conflict': 'Conflict on "{path}" — remote version kept in "{conflictPath}"',
  'main.pushError': 'Sync failed "{path}": {error}',
  'main.createError': "Drive creation error: {error}",
  'main.authCancelled': "Google connection cancelled: {error}",
  'main.invalidCallback': "Invalid OAuth callback (state).",
  'main.tokenFetchFailed': "Failed to retrieve token.",
  'main.claimError': "Claim error: {error}",
  'main.rootListed': "Drive root: {count} items (see console)",
  'main.notConnectedFirst': "Not connected — connect your account in the plugin settings.",
  'main.genericError': "Error: {error}",
  'main.refreshSummary': "Refreshed: {pulled} updated, {conflicts} conflict(s).",
  'main.refreshError': "Refresh error: {error}",
  'main.googleNative': "Native Google file (Docs/Sheets/Slides) — open the .md link note to access it.",
  'main.hydrationError': "Hydration error: {error}",
};

/** Traduit `key` selon la langue courante, interpole `{param}` avec `params`. Retombe sur `key` si absent. */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = currentLang === 'fr' ? FR : EN;
  let s = dict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}
