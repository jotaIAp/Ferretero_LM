require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("🔴 Error: Falta configurar las variables de entorno de Supabase en el .env");
    process.exit(1);
}

// Creamos el cliente oficial
const supabase = createClient(supabaseUrl, supabaseKey);

// CRUCIAL: Exportar directamente la constante 'supabase'
module.exports = supabase;