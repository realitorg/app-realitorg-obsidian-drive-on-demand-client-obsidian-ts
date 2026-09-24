/** Vrai si l'erreur vient de la connexion (hors ligne, réseau coupé, délai dépassé) et non
 *  d'une réponse du drive ou d'une connexion à refaire. Les erreurs du client drive portent
 *  toujours leur code HTTP (« Drive <opération> <code> ») ; une requête qui n'a jamais abouti
 *  n'en a pas. */
export function isNetworkError(e: unknown): boolean {
  const s = String(e);
  if (s.includes('NEED_INTERACTIVE_AUTH')) return false;
  return !/Drive [\w()]+(?: [\w()]+)* \d{3}/.test(s);
}
