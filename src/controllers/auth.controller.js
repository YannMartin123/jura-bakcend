const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/mysql');
require('dotenv').config();

exports.login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const users = await query('SELECT id, email, password, is_active FROM users WHERE email = ? LIMIT 1', [email]);
    const user = users[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    // Generate JWT
    const roles = await query(`SELECT r.name FROM roles r JOIN model_has_roles mr ON mr.role_id = r.id WHERE mr.model_id = ? AND mr.model_type LIKE '%User'`, [user.id]);
    const role = roles.map((item) => item.name).includes('SUPER_ADMIN') ? 'SUPER_ADMIN' : roles[0]?.name || 'USER';
    const token = jwt.sign(
      { id: user.id, email: user.email, role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Internal server error during login.' });
  }
};

