# Scripts d'administration JURA

Ces scripts permettent à l'administrateur technique de créer et gérer les comptes locaux MySQL. Ils ne communiquent pas avec Supabase.

## Prérequis

1. Démarrer MySQL.
2. Vérifier les paramètres de connexion dans `back-end/jura-bakcend/.env` (`DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` et `JWT_SECRET`).
3. Exécuter au préalable les migrations `BD_MIGRATION/2026_08_22_governance_ue_notes.sql`, `BD_MIGRATION/2026_08_22_teacher_ue_assignments.sql`, `BD_MIGRATION/2026_08_22_ec_components.sql` et `BD_MIGRATION/2026_08_22_role_enseignant.sql` afin de disposer des rôles et permissions.
4. Ouvrir un terminal dans le dossier backend :

```powershell
cd "C:\Users\DELL\Documents\Projets\Applications Web\JURA\back-end\jura-bakcend"
```

## Créer un compte

```powershell
node scripts/create-user.js <identifiant> "<nom complet>" <email> "<mot_de_passe>" [ROLE]
```

Exemple :

```powershell
node scripts/create-user.js admin "Administrateur JURA" admin@jura.local "MotDePasseFort" SUPER_ADMIN
```

Le rôle est optionnel, mais il est recommandé de fournir `SUPER_ADMIN` au premier compte. Le mot de passe est enregistré sous forme chiffrée (hachée) ; il ne peut pas être relu.

Pour la création quotidienne de comptes, le `SUPER_ADMIN` peut utiliser la page `/dashboard/admin/comptes`. Les rôles restent attribués séparément dans `/dashboard/admin/acces`. Après exécution de la migration `2026_08_22_user_initial_password.sql`, le mot de passe d'un nouveau compte est provisoire et doit être remplacé à la première connexion.

## Attribuer un rôle ou une permission

```powershell
node scripts/grant-access.js <id_utilisateur> role <ROLE>
node scripts/grant-access.js <id_utilisateur> permission <PERMISSION>
```

Exemples :

```powershell
node scripts/grant-access.js 2 role JURY
node scripts/grant-access.js 3 permission ue.lock
```

Rôles créés par la migration :

- `SUPER_ADMIN` : accès complet, y compris les corrections exceptionnelles.
- `ADMIN_ACADEMIQUE` : administration académique.
- `JURY` : délibérations et production des procès-verbaux.
- `ENSEIGNANT` : saisit les notes d'UE/EC, soumet ses notes et produit les PV de ses seules UE affectées.

Permissions principales : `academic_year.manage`, `users.manage_permissions`, `ue_notes.write`, `ue.lock`, `ue.unlock`, `ue_notes.override_admitted`, `deliberation.manage`, `pv.generate`, `ue_ec.manage`, `ec_notes.write`.

## Lister les comptes et leurs droits

```powershell
node scripts/list-users.js
```

La commande affiche l'identifiant, l'email, l'état du compte, ses rôles et ses permissions directes. Utilisez l'identifiant affiché avec les autres scripts.

## Réinitialiser un mot de passe

```powershell
node scripts/reset-password.js <id_utilisateur|email> "<nouveau_mot_de_passe>"
```

Exemple :

```powershell
node scripts/reset-password.js admin@jura.local "NouveauMotDePasseFort"
```

## Désactiver un compte

```powershell
node scripts/deactivate-user.js <id_utilisateur>
```

Un compte désactivé ne peut plus se connecter, mais son historique est conservé. Il n'est pas supprimé de la base.

## Sécurité

Ne placez jamais un mot de passe réel dans Git, un fichier de commande partagé ou une capture d'écran. Les scripts sont à réserver aux personnes autorisées à administrer les comptes.
