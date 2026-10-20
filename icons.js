// Icônes du système de design de l'État (DSFR, classes fr-icon-*), par nom d'usage dans le widget
const Icons = (function () {
  const names = {
    sliders: 'equalizer-line',
    download: 'download-line',
    copy: 'clipboard-line',
    x: 'close-line',
    swap: 'arrow-left-right-line',
    filter: 'filter-line',
    rows: 'layout-row-line',
    cols: 'layout-column-line',
    table: 'table-line',
    grid: 'layout-grid-line',
    info: 'information-line',
    calendar: 'calendar-line',
    printer: 'printer-line',
    excel: 'file-download-line',
  };
  /** @param {number} size - ≤ 16 : petite icône DSFR (fr-icon--sm), sinon taille normale */
  function get(name, size = 16) {
    const cls = `fr-icon-${names[name] || 'information-line'}${size <= 12 ? ' fr-icon--xs' : size <= 16 ? ' fr-icon--sm' : ''}`;
    return `<span class="icon ${cls}" aria-hidden="true"></span>`;
  }
  /** Classe DSFR seule, pour un composant qui porte lui-même l'icône (encart, bouton) */
  const cls = name => `fr-icon-${names[name] || 'information-line'}`;
  return { get, cls };
})();
