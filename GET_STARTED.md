 cd "C:\Users\DELL\Documents\Projets\Applications Web\JURA\back-end\jura-bakcend"

  # Créer un administrateur
  node scripts/create-user.js admin "Administrateur JURA" admin@jura.local "MotDePasseFort" SUPER_ADMIN

  # Donner un rôle à un utilisateur existant
  node scripts/grant-access.js 2 role JURY

  # Donner une permission spécifique
  node scripts/grant-access.js 3 permission ue.lock

  # Réinitialiser un mot de passe
  node scripts/reset-password.js admin@jura.local "NouveauMotDePasseFort"

  # Lister comptes, rôles et permissions
  node scripts/list-users.js

  # Désactiver un compte
  node scripts/deactivate-user.js 4

  Les scripts utilisent automatiquement la configuration MySQL du fichier .env. Après création du premier compte, connectez-vous avec cet email et mot de
  passe. Si le navigateur conserve un ancien jeton, déconnectez-vous ou videz le stockage local, puis reconnectez-vous.
