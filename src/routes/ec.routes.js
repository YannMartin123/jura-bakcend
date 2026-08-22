const express = require('express');
const { pool, query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const { assertCanManageUe } = require('../middleware/ue-assignment');
const router = express.Router();
router.use(authenticateToken);

router.put('/ue/:idue/mode', requirePermission('ue_ec.manage'), async (req,res,next)=>{
  try { const {mode}=req.body; if(!['SINGLE','MULTIPLE'].includes(mode)) return res.status(400).json({message:'mode SINGLE ou MULTIPLE requis.'});
    await query('INSERT INTO ue_ec_modes (IDUE,mode,configured_by,configured_at,created_at,updated_at) VALUES (?,?,?,NOW(),NOW(),NOW()) ON DUPLICATE KEY UPDATE mode=VALUES(mode),configured_by=VALUES(configured_by),configured_at=NOW(),updated_at=NOW()',[req.params.idue,mode,req.user.id]);
    await audit({user:req.user,action:'UPDATE',module:'STRUCTURE',resourceType:'ue_ec_modes',resourceId:req.params.idue,description:`Mode EC ${mode}`,request:req});res.status(204).end();
  }catch(e){next(e)}
});
router.post('/ue/:idue', requirePermission('ue_ec.manage'), async (req,res,next)=>{
  try{const {intitule,credit,evaluations=[]}=req.body;if(!credit||!Array.isArray(evaluations)||!evaluations.length)return res.status(400).json({message:'credit et evaluations requis.'});if(evaluations.some(x=>!['CC','TP','SN'].includes(x.type)))return res.status(400).json({message:'Types autorisés: CC, TP, SN.'});const c=await pool.getConnection();try{await c.beginTransaction();const [r]=await c.query('INSERT INTO ec (IDUE,INTITULE,CREDIT,created_at,updated_at) VALUES (?,?,?,?,NOW())',[req.params.idue,intitule||null,credit,new Date()]);for(const ev of evaluations)await c.query('INSERT INTO ec_evaluation_types (IDEC,type,ponderation) VALUES (?,?,?)',[r.insertId,ev.type,ev.ponderation||1]);await c.commit();res.status(201).json({id:r.insertId})}catch(e){await c.rollback();throw e}finally{c.release()}}catch(e){next(e)}
});
router.get('/ue/:idue', async(req,res,next)=>{try{const ecs=await query('SELECT e.*,JSON_ARRAYAGG(JSON_OBJECT(\'type\',t.type,\'ponderation\',t.ponderation)) evaluations FROM ec e LEFT JOIN ec_evaluation_types t ON t.IDEC=e.IDEC WHERE e.IDUE=? GROUP BY e.IDEC',[req.params.idue]);res.json(ecs)}catch(e){next(e)}});
router.put('/:idec/notes', requirePermission('ec_notes.write'), async (req,res,next)=>{
  const c=await pool.getConnection(); try { const {matricule,classe_id,annee,note_cc,note_tp,note_sn,motif}=req.body; if(!matricule||!classe_id||!annee||!motif)return res.status(400).json({message:'matricule, classe_id, annee et motif requis.'});
    const [ecRows]=await c.query('SELECT * FROM ec WHERE IDEC=?',[req.params.idec]); if(!ecRows[0])return res.status(404).json({message:'EC introuvable.'}); const ec=ecRows[0];
    await assertCanManageUe({ user:req.user, idue:ec.IDUE, idclasse:classe_id, annee });
    const [lock]=await c.query("SELECT statut FROM ue_class_locks WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?",[classe_id,ec.IDUE,annee]);if(lock[0]&&lock[0].statut!=='OPEN')return res.status(423).json({message:'UE verrouillée.'});
    const [types]=await c.query('SELECT type,ponderation FROM ec_evaluation_types WHERE IDEC=?',[ec.IDEC]);let total=0,weights=0;for(const type of types){const value=type.type==='CC'?note_cc:type.type==='TP'?note_tp:note_sn;if(value===undefined||value===null) return res.status(400).json({message:`Note ${type.type} requise.`});if(Number(value)<0||Number(value)>100)return res.status(400).json({message:'Notes entre 0 et 100.'});total+=Number(value)*Number(type.ponderation);weights+=Number(type.ponderation)} const moyenne=total/weights;
    await c.beginTransaction();await c.query(`INSERT INTO ec_notes (IDEC,MATRICULE,IDCLASSE,ANNEE,note_cc,note_tp,note_sn,moyenne_ec,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE note_cc=VALUES(note_cc),note_tp=VALUES(note_tp),note_sn=VALUES(note_sn),moyenne_ec=VALUES(moyenne_ec),updated_at=NOW()`,[ec.IDEC,String(matricule).toUpperCase(),classe_id,annee,note_cc??null,note_tp??null,note_sn??null,moyenne]);
    const [programme]=await c.query('SELECT CREDIT FROM Programme WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?',[classe_id,ec.IDUE,annee]);const [semester]=await c.query('SELECT IDSEMESTRE FROM programme_semestres WHERE IDCLASSE=? AND IDUE=? AND ANNEE=?',[classe_id,ec.IDUE,annee]);if(!programme[0]||!semester[0])throw new Error('Programme ou semestre UE non configuré.');const [all]=await c.query('SELECT e.CREDIT,n.moyenne_ec FROM ec e JOIN ec_notes n ON n.IDEC=e.IDEC WHERE e.IDUE=? AND n.MATRICULE=? AND n.IDCLASSE=? AND n.ANNEE=?',[ec.IDUE,String(matricule).toUpperCase(),classe_id,annee]);const ueAverage=all.reduce((s,row)=>s+Number(row.CREDIT)*Number(row.moyenne_ec),0)/all.reduce((s,row)=>s+Number(row.CREDIT),0);await c.query('INSERT INTO Moyennes (MATRICULE,IDUE,IDSEMESTRE,ANNEE,MOYENNE,CREDIT,created_at,updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE MOYENNE=VALUES(MOYENNE),CREDIT=VALUES(CREDIT),updated_at=NOW()',[String(matricule).toUpperCase(),ec.IDUE,semester[0].IDSEMESTRE,annee,ueAverage,programme[0].CREDIT]);await c.commit();await audit({user:req.user,action:'UPDATE',module:'NOTES',resourceType:'ec_notes',resourceId:req.params.idec,description:motif,newValues:{moyenne_ec:moyenne,moyenne_ue:ueAverage},request:req});res.json({moyenne_ec:moyenne,moyenne_ue:ueAverage});
  }catch(e){await c.rollback();next(e)}finally{c.release()}
});
module.exports=router;
