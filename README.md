# Recette — contrats de services Mecatherm

Espace de suivi de la recette : tableau des cas de test (À tester, En cours, Validé, Anomalie, Corrigé – à retester), liste, exigences du cahier des charges et journal des retours.

- Site statique publié avec GitHub Pages.
- Retours, déplacements de cartes et captures stockés dans **Supabase** (journal en ajout seul : rien n'est modifiable ni supprimable depuis le site).
- Accès **sans mot de passe** : les testeurs ouvrent le lien, saisissent leur nom et leur e-mail (session anonyme). Be-Cloud se connecte par **lien magique** reçu par e-mail pour répondre aux retours.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `styles.css`, `app.js` | Le site |
| `data.js` | Exigences et cas de test (généré, ne pas éditer à la main) |
| `config.js` | Adresse du projet Supabase et clé publique (anon) |
| `supabase/schema.sql` | Tables, règles d'accès et stockage des captures |
| `tools/build-data.py` | Régénère `data.js` depuis le récapitulatif et le plan de recette |

## Mise en service (une fois)

1. Créer un projet Supabase (offre gratuite), région Europe.
2. **SQL Editor** : exécuter `supabase/schema.sql`, puis ajouter l'administrateur Be-Cloud :
   `insert into public.admins (email) values ('adresse@domaine');`
3. **Authentication > Sign In / Providers** : activer « Allow anonymous sign-ins » ; laisser « Allow new users to sign up » activé (une session anonyme compte comme une inscription) ; garder Email activé. Le site n'expose aucune inscription par mot de passe.
4. **Authentication > URL Configuration** : Site URL = l'adresse GitHub Pages du site.
5. **Project Settings > API** : copier l'URL du projet et la clé `anon` / publishable dans `config.js`, puis pousser.
6. Déclarer l'administrateur Be-Cloud : d'abord créer son accès (ci-dessous), puis en SQL `insert into public.admins (email) values ('adresse@domaine');`.

## Donner un accès

- **Testeurs (client)** : rien à créer. On partage simplement le lien du site ; chaque personne saisit son nom et son e-mail à l'ouverture.
- **Be-Cloud (répondre aux retours)** : **Authentication > Users > Add user > Send invitation** vers l'adresse Be-Cloud (crée le compte sans mot de passe). Une fois l'invitation acceptée et l'adresse ajoutée dans `public.admins`, se connecter ensuite via « Vous êtes Be-Cloud ? Se connecter » sur le site (lien magique).

## Mettre à jour le contenu

```
python tools/build-data.py <recapitulatif-exigences-realisees.md> <plan-recette.md>
```

Le script retire les liens vers le CRM et les noms de personnes : le dépôt est public.

## Récupérer les retours

Bouton **Exporter (CSV)** dans le journal, ou **Table Editor > entries** dans Supabase.

## Aperçu sans base

Ouvrir le site avec `?demo` (ajouter `&admin` pour voir les contrôles Be-Cloud) : les saisies restent dans l'onglet du navigateur, rien n'est envoyé.
