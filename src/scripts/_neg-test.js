require('dotenv').config();
const { sequelize } = require('../config/database');
(async () => {
  const q=(s,r)=>sequelize.query(s,{type:sequelize.QueryTypes.SELECT,replacements:r});
  console.log(await q(`SELECT id, nombre, latitud, longitud, ciudad FROM negocios WHERE id IN ('22222222-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002') OR nombre ILIKE '%don beto%'`));
  await sequelize.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
