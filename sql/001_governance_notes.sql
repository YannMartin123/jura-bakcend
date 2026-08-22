-- JURA: gouvernance des notes, droits, verrous et délibérations.
-- À exécuter dans Supabase SQL Editor avant d'activer les routes associées.

CREATE TABLE IF NOT EXISTS permission (
  code TEXT PRIMARY KEY,
  libelle TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permission (
  role TEXT NOT NULL,
  permission_code TEXT NOT NULL REFERENCES permission(code) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_code)
);

CREATE TABLE IF NOT EXISTS utilisateur_permission (
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateur(id_user) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permission(code) ON DELETE CASCADE,
  accordee_par INTEGER REFERENCES utilisateur(id_user),
  accordee_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expire_at TIMESTAMPTZ,
  PRIMARY KEY (utilisateur_id, permission_code)
);

INSERT INTO permission (code, libelle) VALUES
  ('academic_year.manage', 'Gérer les années académiques'),
  ('users.manage_permissions', 'Administrer les rôles et droits'),
  ('notes.write', 'Saisir ou corriger les notes'),
  ('notes.override_admitted', 'Corriger les notes d''un étudiant admis'),
  ('ue.lock', 'Verrouiller une UE'),
  ('ue.unlock', 'Déverrouiller une UE'),
  ('deliberation.manage', 'Créer et valider les délibérations'),
  ('pv.generate', 'Générer les PV officiels')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permission (role, permission_code)
SELECT 'SUPER_ADMIN', code FROM permission
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role, permission_code) VALUES
  ('ADMIN', 'academic_year.manage'), ('ADMIN', 'ue.lock'), ('ADMIN', 'pv.generate'),
  ('ENSEIGNANT', 'notes.write'), ('ENSEIGNANT', 'pv.generate'),
  ('JURY', 'deliberation.manage'), ('JURY', 'pv.generate')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ue_classe_annee_lock (
  id BIGSERIAL PRIMARY KEY,
  ue_id INTEGER NOT NULL REFERENCES ue(id_ue),
  classe_id INTEGER NOT NULL REFERENCES classe(id_classe),
  annee_id VARCHAR(10) NOT NULL REFERENCES annee_academique(id),
  statut TEXT NOT NULL CHECK (statut IN ('OPEN', 'LOCKED', 'ARCHIVED')) DEFAULT 'OPEN',
  motif TEXT,
  locked_by INTEGER REFERENCES utilisateur(id_user),
  locked_at TIMESTAMPTZ,
  unlocked_by INTEGER REFERENCES utilisateur(id_user),
  unlocked_at TIMESTAMPTZ,
  UNIQUE (ue_id, classe_id, annee_id)
);

CREATE TABLE IF NOT EXISTS note_audit (
  id BIGSERIAL PRIMARY KEY,
  note_id INTEGER,
  etudiant_id INTEGER REFERENCES etudiant(id_etudiant),
  ec_id INTEGER REFERENCES ec(id_ec),
  session_id INTEGER REFERENCES session_correction(id_session),
  annee_id VARCHAR(10) REFERENCES annee_academique(id),
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'OVERRIDE_ADMITTED')),
  old_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  motif TEXT,
  utilisateur_id INTEGER REFERENCES utilisateur(id_user),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS import_batch (
  id UUID PRIMARY KEY,
  ec_id INTEGER NOT NULL REFERENCES ec(id_ec),
  session_id INTEGER NOT NULL REFERENCES session_correction(id_session),
  annee_id VARCHAR(10) REFERENCES annee_academique(id),
  auteur_id INTEGER REFERENCES utilisateur(id_user),
  fichier_nom TEXT,
  fichier_hash TEXT,
  type_fichier TEXT,
  total_lignes INTEGER NOT NULL DEFAULT 0,
  lignes_importees INTEGER NOT NULL DEFAULT 0,
  lignes_erreur INTEGER NOT NULL DEFAULT 0,
  statut TEXT NOT NULL DEFAULT 'CONFIRMED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliberation (
  id BIGSERIAL PRIMARY KEY,
  classe_id INTEGER NOT NULL REFERENCES classe(id_classe),
  annee_id VARCHAR(10) NOT NULL REFERENCES annee_academique(id),
  cycle TEXT NOT NULL,
  statut TEXT NOT NULL CHECK (statut IN ('DRAFT', 'CONTROLLED', 'DELIBERATED', 'PUBLISHED', 'ARCHIVED')) DEFAULT 'DRAFT',
  cree_par INTEGER REFERENCES utilisateur(id_user),
  validee_par INTEGER REFERENCES utilisateur(id_user),
  motif TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_at TIMESTAMPTZ,
  UNIQUE (classe_id, annee_id, cycle)
);

CREATE TABLE IF NOT EXISTS deliberation_decision (
  id BIGSERIAL PRIMARY KEY,
  deliberation_id BIGINT NOT NULL REFERENCES deliberation(id) ON DELETE CASCADE,
  etudiant_id INTEGER NOT NULL REFERENCES etudiant(id_etudiant),
  decision TEXT NOT NULL CHECK (decision IN ('ADMIS', 'AJOURNE', 'EXCLU')),
  mgp NUMERIC(6,2),
  credits_valides NUMERIC(6,2),
  UNIQUE (deliberation_id, etudiant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS only_one_active_academic_year
  ON annee_academique ((est_active)) WHERE est_active;

CREATE OR REPLACE FUNCTION activate_academic_year(p_annee_id VARCHAR)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM annee_academique WHERE id = p_annee_id) THEN
    RAISE EXCEPTION 'Année académique inconnue : %', p_annee_id;
  END IF;
  UPDATE annee_academique SET est_active = FALSE WHERE est_active;
  UPDATE annee_academique SET est_active = TRUE WHERE id = p_annee_id;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_note_audit_note ON note_audit (note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_audit_student ON note_audit (etudiant_id, annee_id, created_at DESC);
