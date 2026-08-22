# Tests HTTP JURA

1. Exécuter `../../BD_MIGRATION/2026_08_22_governance_ue_notes.sql` sur MySQL (`siga_uy1`).
2. Configurer `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` et `JWT_SECRET` dans `.env`.
3. Démarrer l'API : `node index.js`.
4. Ouvrir `jura-api.http` avec l'extension REST Client de VS Code ou un client compatible `.http`.
5. Remplacer les jetons et les identifiants d'exemple avant l'envoi.

Les fichiers du dossier `fixtures` sont des exemples de notes. Ils ne contiennent aucune donnée réelle.

> L'API accepte les JWT émis par `/api/auth/login` et les jetons Supabase Auth. Avec Supabase Auth, l'e-mail doit correspondre à un utilisateur actif de la table `utilisateur`.
