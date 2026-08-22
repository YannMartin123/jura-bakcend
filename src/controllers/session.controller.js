const { supabase } = require('../config/supabase');
const { audit } = require('../services/audit.service');

exports.getActiveSessions = async (req, res) => {
  const teacherId = req.user.id;

  try {
    // In a real scenario, we'd join with EC and Enseignant
    // For now, let's fetch sessions with status 'OUVERTE'
    const { data, error } = await supabase
      .from('session_correction')
      .select(`
        *,
        ec:ec_id (nom, code)
      `)
      .eq('statut', 'OUVERTE');

    if (error) throw error;

    res.status(200).json(data);
  } catch (err) {
    console.error('Error fetching active sessions:', err);
    res.status(500).json({ message: 'Error fetching sessions.' });
  }
};

exports.closeSession = async (req, res) => {
  const { id } = req.params;

  try {
    const { data: existing, error: existingError } = await supabase.from('session_correction').select('*').eq('id_session', id).single();
    if (existingError || !existing) return res.status(404).json({ message: 'Session introuvable.' });
    if (req.user.role === 'ENSEIGNANT' && Number(existing.enseignant_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Vous n’êtes pas responsable de cette session.' });
    if (existing.statut !== 'OUVERTE') return res.status(409).json({ message: 'Cette session n’est pas ouverte.' });

    const { count, error: countError } = await supabase.from('note').select('*', { count: 'exact', head: true }).eq('session_id', id).or('valeur_cc.is.null,valeur_tp.is.null,valeur_sn.is.null');
    if (countError) throw countError;
    if (count > 0) return res.status(409).json({ message: 'Soumission impossible : des notes obligatoires sont absentes.' });

    const { data, error } = await supabase
      .from('session_correction')
      .update({ 
        statut: 'CLOSE',
        closed_at: new Date(),
        closed_by: req.user.id
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await audit({ user: req.user, action: 'CLOSE', module: 'SOUMISSION', resourceType: 'session_correction', resourceId: id, description: 'Soumission et clôture de session', oldValues: existing, newValues: data, request: req });

    // 3. Trigger PV generation or other tasks (could be async)
    
    res.status(200).json({
      message: 'Session closed and locked.',
      session: data
    });
  } catch (err) {
    console.error('Error closing session:', err);
    res.status(500).json({ message: 'Error closing session.' });
  }
};
