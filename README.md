# Widget Tableau Croisé Dynamique (TCD) pour Grist 🇫🇷

Ce widget permet de créer un **tableau croisé dynamique** à partir des données sources de Grist. Il s'appuie entièrement sur [pivottable.js](https://pivottable.js.org/examples/) (interface `pivotUI`, calculs, filtres, tris) et sur [subtotal.js](https://github.com/nagarajanchinnasamy/subtotal) (sous-totaux repliables, carte de chaleur, barres), habillés pour s'intégrer à Grist.

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
- Survol en croix (ligne et colonne) et info-bulle détaillant chaque cellule
- Clic sur une cellule : ses lignes sont transmises aux widgets Grist liés (« Sélectionner par » ce widget) et, si l'option est active, affichées dans un panneau de détail limité aux colonnes du tableau
- Filtres rapides depuis la barre de résumé
- Sous-totaux par groupe (subtotal.js), repliables en cliquant sur un groupe ou sur l'en-tête d'un niveau
- Mise en forme : tableau, carte de chaleur (globale, par ligne, par colonne) ou barres de données
- Nombres au format de la colonne dans Grist (devise, pourcentage, décimales, séparateurs)
- Densité (compacte, standard, aérée) et taille du texte
- Export : copie pour Excel / LibreOffice, CSV (séparateur « ; », compatible Excel français), impression

**Configuration** (bouton « Ouvrir la configuration » de Grist)
- Champs typés (texte, nombre, date) avec recherche
- Regroupement des dates par année, trimestre ou mois (dérivateurs de pivottable)
- Calculs de pivottable : nombre, somme, moyenne, moyenne pondérée, médiane, min/max, écart-type, répartitions en % (du total, de la ligne, de la colonne ou du groupe parent)…
- Filtres de valeurs de pivotUI avec recherche, « tout cocher / tout décocher » et nombre d'occurrences
- Tri des lignes et colonnes (libellé ou valeur), totaux activables
- Thème clair/sombre synchronisé avec Grist
- « Annuler » pour revenir à l'état d'ouverture de la configuration

Les configurations enregistrées par les versions précédentes (y compris en anglais) sont reprises automatiquement.

## Développement

Le widget ne nécessite aucune compilation. Pour le tester hors de Grist, une API Grist simulée et des données fictives sont fournies dans `dev/` :

```bash
npx http-server -p 8765 .
npm install --no-save playwright   # si Playwright n'est pas déjà installé
node dev/test.mjs                  # tests de bout en bout
```

Organisation du code :

| Fichier | Rôle |
| --- | --- |
| `index.js` | Réglages, construction de pivotUI, liaison avec Grist, détail, export |
| `config.js` | Place et habille les éléments de pivotUI dans le panneau de configuration |
| `render.js` | Rendus subtotal.js (tableau, chaleur, barres) et mise en forme du tableau |
| `gristColumns.js` | Formats et libellés des colonnes Grist (logique de formatage de Grist) |
| `data.js` | Préparation des données Grist (types, valeurs, dérivés de dates, tris) |
| `aggregators.js` | Catalogue des calculs transmis à pivotUI |
| `ui.js`, `icons.js` | Popovers, menus, notifications, icônes |
