# Widget Tableau Croisé Dynamique (TCD) pour Grist 🇫🇷

Ce widget permet de créer un **tableau croisé dynamique** à partir des données sources de Grist. Il s'appuie entièrement sur [pivottable.js](https://pivottable.js.org/examples/) (interface `pivotUI`, calculs, filtres, tris) et sur [subtotal.js](https://github.com/nagarajanchinnasamy/subtotal) (sous-totaux repliables, carte de chaleur, barres), habillés pour s'intégrer à Grist.

L'interface utilise le [Système de design de l'État](https://www.systeme-de-design.gouv.fr/) (DSFR 1.15, feuilles de style `@gouvfr/dsfr` : boutons, tags, badges, champs, interrupteurs, boutons segmentés, cases à cocher, tableau, encarts, alertes, info-bulles, modale, icônes et police Marianne), en thème clair ou sombre selon Grist. Le JavaScript du DSFR n'est pas chargé : il ralentissait fortement les longues listes de filtres ; le widget ouvre lui-même sa seule modale. Le DSFR et la police Marianne sont réservés aux sites des services de l'État.

Il s'agit d'une refonte du widget intégré à Grist Labs, dont l'auteur original est [jperon](https://github.com/jperon).

Cette version du widget est développée par [Arthur Panckoucke](https://github.com/Arthurpanck).

## Utilisation

1. Ajoutez un widget personnalisé à votre page Grist avec l'URL de ce widget et l'accès **« Lecture de la table »**.
2. Dans le panneau de droite de Grist, cliquez sur **« Ouvrir la configuration »**.
3. Glissez les champs dans **Lignes** et **Colonnes** (ou cliquez sur un champ pour choisir où le placer), choisissez le calcul, puis cliquez sur **Terminer**.

Les réglages sont enregistrés automatiquement dans le widget.

### Accès du widget

- **Lecture de la table** (suffisant) : les nombres s'affichent au format par défaut de Grist et les champs sous leur identifiant.
- **Accès complet** (recommandé) : le widget lit en plus les métadonnées du document pour reprendre le **format** (devise, %, décimales) et le **libellé** de chaque colonne, comme dans le tableur Grist. Il n'écrit jamais dans les données.

## Fonctionnalités

**Consultation**
- Tableau lisible par défaut, sans interface d'édition : en-têtes et totaux figés lors du défilement
- Titre personnalisé : remplace la description automatique dans la barre de résumé, légende du tableau pour les lecteurs d'écran, repris dans l'export Excel
- Survol en croix (ligne et colonne) et info-bulle détaillant chaque cellule
- Clic sur une cellule : comme un point du widget Carte, elle filtre les widgets Grist liés (« Sélectionner par » ce widget) ; un second clic ou Échap réaffiche tout. La sélection est conservée quand les données changent
- Groupes repliés conservés d'un recalcul à l'autre ; au-delà de 1 500 lignes, bouton « Afficher les lignes restantes »
- Filtres rapides depuis la barre de résumé
- Sous-totaux par groupe (subtotal.js), repliables en cliquant sur un groupe ou sur l'en-tête d'un niveau
- Mise en forme : tableau, carte de chaleur (globale, par ligne, par colonne) ou barres de données
- Nombres au format de la colonne dans Grist (devise, pourcentage, décimales, séparateurs), avec un arrondi propre au tableau si besoin (entier, 1 à 3 décimales) : affichage et export Excel, les calculs gardent les valeurs exactes
- Export Excel mis en forme (.xlsx) : formats de nombres des colonnes Grist (devise, %, décimales), sous-totaux en plan repliable (groupes repliés dans le widget repliés dans Excel), totaux en gras, en-têtes et volets figés, carte de chaleur et barres en mise en forme conditionnelle
- Export des données brutes : copie pour un tableur, CSV (séparateur « ; », compatible Excel français)

**Configuration** (bouton « Ouvrir la configuration » de Grist)
- Champs typés (texte, nombre, date) avec recherche
- Regroupement des dates par année, trimestre ou mois (dérivateurs de pivottable)
- Calculs de pivottable : nombre, somme, moyenne, moyenne pondérée, médiane, min/max, écart-type, répartitions en % (du total, de la ligne, de la colonne ou du groupe parent)…
- Filtres de valeurs de pivotUI avec recherche, « tout cocher / tout décocher » et nombre d'occurrences
- Tri des lignes et colonnes (libellé ou valeur), totaux activables
- Densité (compacte, standard, aérée) et taille du texte
- Thème clair/sombre synchronisé avec Grist
- « Annuler » pour revenir à l'état d'ouverture de la configuration
- Configuration sur tout le widget, en trois colonnes (champs, disposition, affichage) ; « Aperçu du tableau » ouvre le tableau à jour dans une modale du DSFR (Fermer, Échap ou clic à l'extérieur)

Les configurations enregistrées par les versions précédentes (y compris en anglais) sont reprises automatiquement.

## Développement

Le widget ne nécessite aucune compilation. Pour le tester hors de Grist, une API Grist simulée et des données fictives sont fournies dans `dev/` :

```bash
npx http-server -p 8765 .
npm install --no-save playwright exceljs   # outils de test (Playwright, lecture des exports Excel)
node dev/test.mjs                  # tests de bout en bout
node dev/fuzz.mjs 42 300           # robustesse : 300 actions au hasard (graine 42)
```

À chaque publication, changer la version `?v=` des fichiers dans `index.html`, dans un commit poussé **après** que GitHub sert les nouveaux fichiers (raw.githubusercontent.com met quelques minutes à se mettre à jour) : sinon raw.githack enregistre les anciens fichiers sous la nouvelle version.

### Ce qui vient des librairies, du DSFR et du widget

- **pivottable.js** (pivotUI) : glisser-déposer des champs, fenêtres de filtre, calculs, tris, dérivés de dates, carte de chaleur et barres.
- **subtotal.js** : rendu du tableau avec sous-totaux repliables et calculs « en % du groupe ».
- **DSFR** : tous les composants visuels (classes `fr-*`), icônes, couleurs (variables du DSFR), police et thème sombre.
- **ExcelJS** : écriture du classeur Excel, chargé à la première exportation.
- **Le widget** : liaison avec Grist (données, formats et libellés, enregistrement des réglages, sélection des vues liées), placement et habillage DSFR des éléments de pivotUI, export Excel mis en forme, CSV et copie, en-têtes figés, mémoire des groupes repliés et de la sélection, limite d'affichage, aperçu en modale, navigation au clavier.
Organisation du code :

| Fichier | Rôle |
| --- | --- |
| `index.js` | Réglages, construction de pivotUI, liaison avec Grist, sélection |
| `export.js` | Exports : Excel mis en forme (ExcelJS, chargé à la demande), CSV, copie |
| `config.js` | Place et habille les éléments de pivotUI dans le panneau de configuration |
| `render.js` | Rendus subtotal.js (tableau, chaleur, barres) et mise en forme du tableau |
| `gristColumns.js` | Formats et libellés des colonnes Grist (logique de formatage de Grist) |
| `data.js` | Préparation des données Grist (types, valeurs, dérivés de dates, tris) |
| `aggregators.js` | Catalogue des calculs transmis à pivotUI |
| `ui.js` | Popovers, menus, notifications et contrôles segmentés (composants du DSFR) |
