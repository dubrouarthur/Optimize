# 💍 Plan de table

Un logiciel **simple, beau et intuitif** pour créer le plan de table d'un mariage.
Inscrivez vos invités, créez vos tables, glissez-déposez chacun à sa place, et
visualisez la salle en un coup d'œil.

![aperçu](docs/preview.png)

## Fonctionnalités

- **Inscription des invités** en un clic, avec groupes colorés (famille, amis, collègues…).
- **Tables visuelles** rondes ou rectangulaires, avec chaises tout autour.
- **Glisser-déposer** : placez un invité sur une chaise, déplacez-le, échangez deux places.
- **Plan de salle** : déplacez les tables où vous voulez sur le plan.
- **Placement automatique** (✨) : remplit les places libres en gardant les groupes ensemble.
- **Compteurs en direct** : invités placés, tables, places libres.
- **Recherche** instantanée d'un invité.
- **Impression / export PDF** d'un beau plan de table prêt à afficher.
- **Sauvegarde automatique** dans une base de données **SQLite locale** (fichier `data.sqlite`).
  Tout reste sur votre machine, fonctionne hors-ligne.

## Démarrage

```bash
npm install
npm start
```

Puis ouvrez **http://localhost:3000**.

> Pour développer avec rechargement auto : `npm run dev`.

## Comment ça marche

| Action | Geste |
| --- | --- |
| Ajouter un invité | Saisir le nom + (groupe) → **Ajouter** |
| Créer une table | **⊕ Table ronde / rectangle** dans la barre du plan |
| Placer un invité | Glisser sa pastille depuis « À placer » vers une chaise |
| Déplacer / échanger | Glisser un invité d'une chaise à une autre |
| Libérer une place | Clic sur l'invité assis (ou le glisser vers « À placer ») |
| Renommer / +/- places / forme | Survoler une table → outils sous la table |
| Déplacer une table | Glisser le disque de la table sur le plan |

## Pile technique

- **Backend** : Node.js + Express + `better-sqlite3` (base de données embarquée).
- **Frontend** : HTML/CSS/JS natif, sans étape de build — léger et rapide.
- **Base de données** : SQLite locale (`data.sqlite`), créée automatiquement au premier lancement.

## Structure

```
server.js        API REST + serveur statique
db.js            schéma SQLite + données par défaut
public/          interface (index.html, styles.css, app.js)
```
