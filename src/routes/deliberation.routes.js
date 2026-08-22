const express = require('express');
const { query } = require('../config/mysql');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../services/audit.service');
const router = express.Router();
router.use(authenticateToken, requirePermission('deliberation.manage'));

router.post('/', async (req, res, next) => {
  try {
    const { classe_id, annee, cycle, motif } = req.body;
    if (!classe_id || !annee || !cycle) return res.status(400).json({ message: 'classe_id, annee et cycle requis.' });
    const result = await query('INSERT INTO deliberations (IDCLASSE,ANNEE,cycle,motif,created_by,created_at,updated_at) VALUES (?,?,?,?,?,NOW(),NOW())', [classe_id, annee, cycle, motif || null, req.user.id]);
    const item = (await query('SELECT * FROM deliberations WHERE id=?', [result.insertId]))[0];
    await audit({ user:req.user, action:'CREATE', module:'JURY', resourceType:'deliberations', resourceId:item.id, description:'Création de délibération', newValues:item, request:req });
    res.status(201).json(item);
  } catch (error) { next(error); }
});

router.put('/:id/decisions', async (req, res, next) => {
  try {
    const { decisions } = req.body;
    if (!Array.isArray(decisions) || !decisions.length) return res.status(400).json({ message:'decisions requis.' });
    const deliberation = (await query('SELECT * FROM deliberations WHERE id=?', [req.params.id]))[0];
    if (!deliberation) return res.status(404).json({ message:'Délibération introuvable.' });
    if (!['DRAFT','CONTROLLED','DELIBERATED'].includes(deliberation.statut)) return res.status(409).json({ message:'Délibération non modifiable.' });
    for (const decision of decisions) {
      if (!decision.matricule || !['ADMIS','AJOURNE','EXCLU'].includes(decision.decision)) return res.status(400).json({ message:'Décision invalide.' });
      await query(`INSERT INTO deliberation_decisions (deliberation_id,MATRICULE,decision,mgp,credits_valides) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE decision=VALUES(decision),mgp=VALUES(mgp),credits_valides=VALUES(credits_valides)`, [deliberation.id, decision.matricule.toUpperCase(), decision.decision, decision.mgp ?? null, decision.credits_valides ?? null]);
    }
    await audit({ user:req.user, action:'UPDATE', module:'JURY', resourceType:'deliberations', resourceId:deliberation.id, description:'Décisions mises à jour', newValues:{count:decisions.length}, request:req });
    res.json({ success:true, count:decisions.length });
  } catch (error) { next(error); }
});

router.post('/:id/publish', async (req, res, next) => {
  try {
    const item = (await query('SELECT * FROM deliberations WHERE id=?', [req.params.id]))[0];
    if (!item) return res.status(404).json({ message:'Délibération introuvable.' });
    if (!['CONTROLLED','DELIBERATED'].includes(item.statut)) return res.status(409).json({ message:'La délibération doit être contrôlée avant publication.' });
    await query("UPDATE deliberations SET statut='PUBLISHED',validated_by=?,validated_at=NOW(),updated_at=NOW() WHERE id=?", [req.user.id,item.id]);
    const updated=(await query('SELECT * FROM deliberations WHERE id=?',[item.id]))[0];
    await audit({ user:req.user, action:'PUBLISH', module:'JURY', resourceType:'deliberations', resourceId:item.id, description:'Publication de délibération', oldValues:item,newValues:updated,request:req });
    res.json(updated);
  } catch (error) { next(error); }
});
module.exports = router;
