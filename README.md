# 💍 Plan de table

Un logiciel **simple, beau et intuitif** pour créer le plan de table d'un mariage.
Inscrivez vos invités, créez vos tables, glissez-déposez chacun à sa place, et
visualisez la salle en un coup d'œil.

![aperçu](docs/preview.png)

## Fonctionnalités

- **Collaboratif en temps réel** : plusieurs personnes ouvrent la même page et voient
  **les mêmes changements en direct**. Dès qu'un participant ajoute un invité, place
  quelqu'un ou modifie une table, l'écran de tout le monde se met à jour automatiquement
  (indicateur « ● En direct »). Aucune actualisation nécessaire.
- **Inscription des invités** en un clic, avec groupes colorés (famille, amis, collègues…),
  **régime / allergies alimentaires** et notes par invité (badge 🍽️ et point rouge sur la chaise).
- **Import Excel / CSV avec choix des colonnes** : déposez un fichier `.xlsx` ou `.csv`,
  associez vos colonnes (Nom, Groupe, Régime/Allergies, Notes) — détection automatique des
  en-têtes et aperçu avant import. (Ou collez simplement une liste de noms.)
- **Sauvegarde & restauration** : exportez tout le plan (tables + placement + invités) dans un
  fichier `.json` (💾 Sauvegarder), puis rechargez-le plus tard pour tout restaurer à l'identique.
- **Plan en grille nette** : les tables s'alignent automatiquement dans une grille
  responsive — elles ne se chevauchent jamais et restent toujours lisibles.
- **Tables visuelles** rondes ou rectangulaires, avec chaises tout autour, de
  **2 à 100 places** (les chaises et la table s'adaptent automatiquement à la taille).
- **Trois façons de remplir une chaise** :
  - **Glisser-déposer** un invité sur une chaise (placer, déplacer, échanger) ;
  - **Clic-pour-placer** (idéal tactile/mobile) : on clique un invité, puis une chaise ;
  - **Saisie directe sur la place** : on clique une chaise vide et on tape le nom — l'invité
    est créé et assis d'un coup, puis le curseur passe à la chaise suivante (saisie en rafale).
- **Édition de table en un clic** : cliquez une table pour ouvrir un panneau clair —
  nom, **nombre de places** (stepper ou saisie directe, jusqu'à 100), forme
  ronde ↔ rectangulaire, **couleur d'arrière-plan** (palette élégante), suppression.
- **Placement automatique** (✨) intelligent : remplit les places libres en gardant
  chaque groupe **à la même table** quand c'est possible.
- **Filtre par groupe** et **recherche** instantanée dans la liste des invités.
- **Compteurs en direct** : invités placés, tables, places libres.
- **Export CSV/Excel** (⬇️) — avec colonnes Régime/Allergies et Notes.
- **Export PDF** (📄) soigné : page de garde, **plan visuel des tables**, répartition par table,
  index alphabétique des invités → table, et **récapitulatif des régimes & allergies** (pour le traiteur).
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
| Modifier un invité (régime, etc.) | Survoler sa pastille → **✎** → nom, groupe, régime/allergies, notes |
| Importer un fichier Excel/CSV | **⊕ Importer une liste** → choisir le fichier → associer les colonnes → Importer |
| Modifier une table | **Cliquer la table** → panneau (nom, places, forme, arrière-plan, suppression) |
| Régler le nombre de places | Dans le panneau : boutons +/− ou saisie directe (jusqu'à 100) |
| Changer la couleur de table | Dans le panneau : choisir une pastille d'« Arrière-plan » |
| Sauvegarder / restaurer | **💾 Sauvegarder** (fichier .json) · restaurer via « Importer » |
| Exporter | **⬇️ CSV** (Excel) ou **📄 PDF** |

## Pile technique

- **Backend** : Node.js + Express + `better-sqlite3` (base de données embarquée) + `xlsx` (lecture Excel/CSV).
- **Frontend** : HTML/CSS/JS natif, sans étape de build — léger et rapide.
- **Temps réel** : Server-Sent Events (`/api/events`) — le serveur pousse un signal à tous
  les navigateurs connectés après chaque modification, et chacun se resynchronise (sans
  dépendance externe ni WebSocket).
- **Base de données** : SQLite locale (`data.sqlite`), créée automatiquement au premier lancement.

## Structure

```
server.js        API REST + serveur statique
db.js            schéma SQLite + données par défaut
public/          interface (index.html, styles.css, app.js)
```
