const express = require('express');
const { pool, query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const router = express.Router();
router.use(authenticateToken);

router.get('/academic-years', async (req,res,next) => { try { res.json(await query('SELECT * FROM academic_years ORDER BY annee DESC')); } catch(e){ next(e); } });
router.post('/academic-years', requirePermission('academic_year.manage'), async (req,res,next) => {
  try { const { annee,date_debut,date_fin }=req.body; if(!annee||!date_debut||!date_fin) return res.status(400).json({message:'annee, date_debut et date_fin requis.'});
    await query('INSERT INTO academic_years (annee,date_debut,date_fin,est_active,created_by,created_at,updated_at) VALUES (?,?,?,0,?,NOW(),NOW())',[annee,date_debut,date_fin,req.user.id]);
    const item=(await query('SELECT * FROM academic_years WHERE annee=?',[annee]))[0]; await audit({user:req.user,action:'CREATE',module:'PARAMETRES',resourceType:'academic_years',resourceId:annee,description:'Création année académique',newValues:item,request:req}); res.status(201).json(item);
  } catch(e){ next(e); }
});
router.post('/academic-years/:annee/activate', requirePermission('academic_year.manage'), async (req,res,next) => {
  const connection=await pool.getConnection(); try { await connection.beginTransaction(); await connection.query('UPDATE academic_years SET est_active=0,updated_at=NOW() WHERE est_active=1'); const [result]=await connection.query('UPDATE academic_years SET est_active=1,updated_at=NOW() WHERE annee=?',[req.params.annee]); if(!result.affectedRows) throw Object.assign(new Error('Année introuvable.'),{status:404}); await connection.commit(); await audit({user:req.user,action:'UPDATE',module:'PARAMETRES',resourceType:'academic_years',resourceId:req.params.annee,description:'Activation année académique',newValues:{est_active:true},request:req}); res.json({success:true,annee:Number(req.params.annee)}); } catch(e){await connection.rollback();next(e)} finally {connection.release()}
});
router.put('/users/:id/roles/:role', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try { const role=(await query('SELECT id FROM roles WHERE name=? LIMIT 1',[req.params.role]))[0]; if(!role) return res.status(404).json({message:'Rôle introuvable.'}); await query("INSERT IGNORE INTO model_has_roles (role_id,model_type,model_id) VALUES (?,'App\\\\Models\\\\User',?)",[role.id,req.params.id]); await audit({user:req.user,action:'ASSIGN',module:'ADMIN',resourceType:'users',resourceId:req.params.id,description:`Attribution rôle ${req.params.role}`,request:req}); res.status(204).end(); } catch(e){next(e)}
});
router.put('/users/:id/permissions/:permission', requirePermission('users.manage_permissions'), async (req,res,next) => {
  try { const permission=(await query('SELECT id FROM permissions WHERE name=? LIMIT 1',[req.params.permission]))[0]; if(!permission) return res.status(404).json({message:'Permission introuvable.'}); await query("INSERT IGNORE INTO model_has_permissions (permission_id,model_type,model_id) VALUES (?,'App\\\\Models\\\\User',?)",[permission.id,req.params.id]); await audit({user:req.user,action:'ASSIGN',module:'ADMIN',resourceType:'users',resourceId:req.params.id,description:`Attribution permission ${req.params.permission}`,request:req}); res.status(204).end(); } catch(e){next(e)}
});
module.exports=router;
