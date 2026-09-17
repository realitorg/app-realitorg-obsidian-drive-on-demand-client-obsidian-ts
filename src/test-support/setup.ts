// Chargé avant chaque fichier de test (vitest `setupFiles`).
import { setConfigDir } from '../mirror/tree-mirror';

// Dans Obsidian, le plugin fixe le dossier de configuration au chargement.
setConfigDir('.obsidian');

// Les minuteries passent par `window` (fenêtres détachées d'Obsidian) : en Node, `window`
// est l'objet global.
if (typeof window === 'undefined') {
  (global as { window?: unknown }).window = global;
}
