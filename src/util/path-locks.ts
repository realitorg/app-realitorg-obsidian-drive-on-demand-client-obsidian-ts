/** Sérialise les opérations sur un même chemin : un envoi et un rafraîchissement du même
 *  fichier ne doivent jamais s'entrelacer (l'un lirait la révision que l'autre est en
 *  train d'écrire, et verrait un faux conflit). Chemins différents : en parallèle. */
export class PathLocks {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(path) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(path, tail);
    void tail.then(() => {
      if (this.tails.get(path) === tail) this.tails.delete(path);
    });
    return next;
  }
}
