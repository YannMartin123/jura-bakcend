const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseUrl.startsWith('http')) {
  console.warn('⚠️ Warning: SUPABASE_URL is not set or invalid. Backend may fail to start.');
}

const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co', 
  supabaseKey || 'placeholder'
);

module.exports = {
  supabase
};
