# Widget Tableau Croisé Dynamique (TCD) pour Grist 🇫🇷

Ce widget permet de créer un **tableau croisé dynamique** à partir des données sources de Grist, basé sur le moteur de calcul de [pivottable.js](https://pivottable.js.org/examples/).

Il s'agit d'une refonte du widget intégré à Grist Labs, dont l'auteur original est [jperon](https://github.com/jperon).

Cette version du widget est développée par [Arthur Panckoucke](https://github.com/Arthurpanck).

## Utilisation

1. Ajoutez un widget personnalisé à votre page Grist avec l'URL de ce widget et l'accès **« Lecture de la table »**.
2. Dans le panneau de droite de Grist, cliquez sur **« Ouvrir la configuration »**.
3. Glissez les champs dans **Lignes** et **Colonnes** (ou cliquez sur un champ pour choisir où le placer), choisissez le calcul, puis cliquez sur **Terminer**.

Les réglages sont enregistrés automatiquement dans le widget.

## Fonctionnalités

**Consultation**
- Tableau lisible par défaut, sans interface d'édition : en-têtes et totaux figés lors du défilement
- Survol en croix (ligne et colonne) et info-bulle détaillant chaque cellule
- Clic sur une cellule : détail des lignes sources, transmises aux widgets Grist liés (« Sélectionner par » ce widget)
- Filtres rapides depuis la barre de résumé
- Sous-totaux par groupe, repliables (individuellement ou tous à la fois)
- Mise en forme : tableau, carte de chaleur (globale, par ligne, par colonne), barres de données ou graphique (colonnes, empilées, barres, courbes)
- Densité (compacte, standard, aérée) et taille du texte
- Export : copie pour Excel / LibreOffice, CSV (séparateur « ; », compatible Excel français), impression

**Configuration** (bouton « Ouvrir la configuration » de Grist)
- Champs typés (texte, nombre, date) avec recherche
- Regroupement des dates par année, trimestre ou mois
- Calculs : nombre, somme, moyenne, moyenne pondérée, médiane, min/max, écart-type, répartitions en %…
- Filtres de valeurs avec recherche, « tout cocher », « seulement », et nombre d'occurrences
- Tri des lignes et colonnes (libellé ou valeur), totaux activables
- Format des nombres : décimales, échelle (milliers, millions), unité (€, %, h…)
- Couleur d'accent, thème clair/sombre synchronisé avec Grist
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
| `index.js` | État, liaison avec Grist, rendu, détail, export |
| `config.js` | Panneau de configuration |
| `render.js` | Calcul pivottable, construction du tableau, sous-totaux, mise en forme |
| `chartView.js` | Vue graphique (Chart.js chargé à la demande) |
| `data.js` | Préparation des données Grist (types, dates, valeurs vides, tri) |
| `aggregators.js` | Catalogue des calculs et format des nombres |
| `ui.js`, `icons.js` | Popovers, menus, notifications, icônes |
