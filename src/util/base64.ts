/** Base64 du texte UTF-8, sans `escape`/`unescape` (obsolètes) : même résultat que
 *  l'ancien `btoa(unescape(encodeURIComponent(s)))`, donc les données déjà enregistrées
 *  se relisent telles quelles. */
export function utf8ToBase64(s: string): string {
  let binaire = '';
  for (const octet of new TextEncoder().encode(s)) binaire += String.fromCharCode(octet);
  return btoa(binaire);
}

export function base64ToUtf8(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}
