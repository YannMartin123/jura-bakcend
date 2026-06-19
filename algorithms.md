# Algorithmes des 05 Fonctionnalités de la Plateforme JURA

Ce document présente les algorithmes pour cinq fonctionnalités clés du système de gestion académique JURA.

---

## 1. Importation des Notes avec Anonymat
**Description** : Permet d'importer des notes à partir d'un fichier en utilisant des codes d'anonymat au lieu des matricules.

```pseudo
ALGORITHME ImportationNotesAnonymes
ENTRÉES: Liste de couples (code_anonymat, note), EC_id
SORTIE: Rapport d'importation

DÉBUT
    POUR CHAQUE (code, note) DANS Liste ALORS
        RECHERCHER l'étudiant correspondant au 'code' dans la table 'anonymat' pour l'EC_id
        
        SI étudiant trouvé ALORS
            SI note est valide (0-20) ALORS
                ENREGISTRER la note pour cet étudiant dans la table 'notes'
                AJOUTER "Succès" au rapport
            SINON
                AJOUTER "Erreur: Note invalide" au rapport
            FIN SI
        SINON
            AJOUTER "Erreur: Code d'anonymat inconnu" au rapport
        FIN SI
    FIN POUR CHAQUE

    RETOURNER Rapport
FIN
```

---

## 2. Génération du Procès-Verbal (PV) de Notes
**Description** : Calcule les moyennes et génère un document récapitulatif pour une UE/EC.

```pseudo
ALGORITHME GenerationPV
ENTRÉES: EC_id, Classe_id
SORTIE: Liste des moyennes et observations

DÉBUT
    LIRE tous les étudiants inscrits à Classe_id
    LIRE toutes les notes pour EC_id
    
    POUR CHAQUE étudiant ALORS
        CALCULER moyenne = (Note_CC * 0.3) + (Note_Examen * 0.7)
        
        SI moyenne >= 10 ALORS
            observation = "Validé"
        SINON
            observation = "Non Validé"
        FIN SI
        
        AJOUTER (étudiant, moyenne, observation) à la liste finale
    FIN POUR CHAQUE

    RETOURNER Liste finale triée par nom
FIN
```

---

## 3. Gestion de la Structure Académique (Départements)
**Description** : Ajout d'un nouveau département au sein d'un établissement.

```pseudo
ALGORITHME CreerDepartement
ENTRÉES: nom, code, etablissement_id
SORTIE: Succès ou Erreur

DÉBUT
    SI le 'code' existe déjà pour cet établissement ALORS
        RETOURNER Erreur "Code département déjà existant"
    FIN SI

    CRÉER une nouvelle entrée dans la table 'departements'
    ASSOCIER le département à etablissement_id
    
    RETOURNER Succès
FIN
```

---

## 4. Soumission des Notes par un Enseignant
**Description** : Permet à un enseignant de finaliser et verrouiller la saisie des notes.

```pseudo
ALGORITHME SoumissionNotes
ENTRÉES: EC_id, Enseignant_id
SORTIE: Confirmation de verrouillage

DÉBUT
    VÉRIFIER si toutes les notes sont saisies pour l'EC_id
    
    SI manque des notes ALORS
        RETOURNER Erreur "Saisie incomplète"
    FIN SI

    CHANGER le statut de la session de notes pour EC_id à "CLOSE"
    ENREGISTRER l'horodatage et l'ID de l'enseignant (signature numérique)
    
    EMPÊCHER toute modification ultérieure des notes pour cette session
    
    RETOURNER Succès "Notes soumises et verrouillées"
FIN
```

---

## 5. Agrégation des Données du Tableau de Bord (Dashboard)
**Description** : Calcule les statistiques globales pour la vue administrateur/enseignant.

```pseudo
ALGORITHME CalculStatsDashboard
ENTRÉES: Enseignant_id (ou NULL pour Admin)
SORTIE: Statistiques (Nombre étudiants, Taux réussite, etc.)

DÉBUT
    LIRE les cours associés à l'Enseignant_id
    COMPTER le nombre total d'étudiants uniques inscrits à ces cours
    
    RÉCUPÉRER toutes les notes validées
    CALCULER Taux_Reussite = (Nombre_Notes >= 10) / (Nombre_Total_Notes) * 100
    
    IDENTIFIER les 5 meilleures performances par EC
    
    RETOURNER Objet {total_etudiants, taux_reussite, top_performances}
FIN
```
