const { supabase } = require('../config/supabase');

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
    // 1. Check if all grades are entered (business logic)
    // 2. Update status to 'CLOSE'
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
