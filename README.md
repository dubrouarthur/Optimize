# 💍 Plan de table

Un logiciel **simple, beau et intuitif** pour créer le plan de table d'un mariage.
Inscrivez vos invités, créez vos tables, glissez-déposez chacun à sa place, et
visualisez la salle en un coup d'œil.

![aperçu](docs/preview.png)

## Fonctionnalités

- **Inscription des invités** en un clic, avec groupes colorés (famille, amis, collègues…).
- **Import en masse** : collez une liste de noms (un par ligne) pour ajouter tout le monde d'un coup.
- **Tables visuelles** rondes ou rectangulaires, avec chaises tout autour.
- **Trois façons de remplir une chaise** :
  - **Glisser-déposer** un invité sur une chaise (placer, déplacer, échanger) ;
  - **Clic-pour-placer** (idéal tactile/mobile) : on clique un invité, puis une chaise ;
  - **Saisie directe sur la place** : on clique une chaise vide et on tape le nom — l'invité
    est créé et assis d'un coup, puis le curseur passe à la chaise suivante (saisie en rafale).
- **Taille de table réglable** : boutons +/− ou clic sur le nombre de places pour saisir
  directement le total ; tables rondes ↔ rectangulaires.
- **Plan de salle** : déplacez les tables où vous voulez sur le plan.
- **Placement automatique** (✨) intelligent : remplit les places libres en gardant
  chaque groupe **à la même table** quand c'est possible.
- **Filtre par groupe** et **recherche** instantanée dans la liste des invités.
- **Compteurs en direct** : invités placés, tables, places libres.
- **Export CSV/Excel** (⬇️) et **export PDF** (📄) : un document élégant avec page de garde,
  répartition par table et index alphabétique des invités → table.
- **Responsive** : utilisable sur ordinateur, tablette et mobile.
- **Sauvegarde automatique** dans une base de données **SQLite locale** (fichier `data.sqlite`).
  Tout reste sur votre machine, fonctionne hors-ligne.

## Démarrage

```bash
npm install
npm start
```

Puis ouvrez **http://localhost:3000**.

> Pour développer avec rechargement auto : `npm run dev`.

## Déploiement (Railway, etc.)

L'app démarre avec `npm start` et écoute sur le port fourni par `process.env.PORT`
(3000 par défaut) — aucune configuration spéciale n'est requise.

> ⚠️ **Persistance des données.** Sur les hébergeurs au système de fichiers
> éphémère (Railway, Render…), le fichier `data.sqlite` est effacé à chaque
> redéploiement. Pour conserver le plan de table, montez un **volume persistant**
> et pointez la base dessus via une variable d'environnement :
>
> | Variable | Effet |
> | --- | --- |
> | `DATA_DIR` | Dossier où créer `data.sqlite` (ex. le point de montage du volume, `/data`) |
> | `SQLITE_PATH` | Chemin complet du fichier de base (prioritaire sur `DATA_DIR`) |
>
> Exemple Railway : ajouter un volume monté sur `/data`, puis définir `DATA_DIR=/data`.

## Comment ça marche

| Action | Geste |
| --- | --- |
| Ajouter un invité | Saisir le nom + (groupe) → **Ajouter** |
| Importer une liste | **⊕ Importer une liste** → coller les noms (un par ligne) |
| Créer une table | **⊕ Table ronde / rectangle** dans la barre du plan |
| Saisir un invité sur une place | Cliquer une chaise vide → taper le nom → Entrée (puis chaise suivante) |
| Placer un invité (souris) | Glisser sa pastille depuis « À placer » vers une chaise |
| Placer un invité (tactile) | Cliquer l'invité (il s'illumine) puis cliquer une chaise |
| Déplacer / échanger | Glisser un invité d'une chaise à une autre |
| Libérer une place | Clic sur l'invité assis (ou le glisser vers « À placer ») |
| Régler le nombre de places | Survoler la table → +/− ou clic sur le nombre |
| Renommer / forme | Survoler une table → outils sous la table |
| Déplacer une table | Glisser le disque de la table sur le plan |
| Exporter | **⬇️ CSV** (Excel) ou **📄 PDF** |

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
