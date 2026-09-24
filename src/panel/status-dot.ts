const SVG_NS = 'http://www.w3.org/2000/svg';

/** Témoin d'état dessiné en un seul SVG (cercle + coche ou croix sur une même grille) :
 *  un cercle en bordure CSS et une icône Lucide posée dedans ne tombaient jamais
 *  exactement au centre sur iOS. */
export function statusDot(kind: 'offline' | 'partial' | 'online' | 'local'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'gdrive-fod-dot');
  svg.dataset.state = kind;
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '6.75');
  svg.appendChild(circle);
  const mark = document.createElementNS(SVG_NS, 'path');
  mark.setAttribute('d', kind === 'online' ? 'M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4' : kind === 'local' ? 'M8 11V5.2M5.6 7.6 8 5.2l2.4 2.4' : 'M4.9 8.3 7 10.4 11.1 6');
  svg.appendChild(mark);
  return svg;
}
