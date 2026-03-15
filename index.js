const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
app.use(express.json());

const connectionString = "postgresql://aqi_system_user:uYgQokcxGdGplUFLxstVfth6cVkcRBU6@dpg-d6rckes50q8c73c096l0-a.singapore-postgres.render.com/aqi_system";
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// Khởi tạo 2 bảng: 1 bảng LOGS (dữ liệu), 1 bảng REGISTRY (vị trí)
const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS air_quality_logs (
      id SERIAL PRIMARY KEY, device_id VARCHAR(50), temp FLOAT, humid FLOAT, mq135 FLOAT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS device_registry (
      device_id VARCHAR(50) PRIMARY KEY, lat FLOAT, lon FLOAT, location_name TEXT
    );
  `);
};
initDb();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// API Đăng ký vị trí thiết bị
app.post('/register-device', async (req, res) => {
  const { deviceId, lat, lon, locationName } = req.body;
  try {
    await pool.query(
      `INSERT INTO device_registry (device_id, lat, lon, location_name) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (device_id) DO UPDATE SET lat = $2, lon = $3, location_name = $4`,
      [deviceId, lat, lon, locationName]
    );
    res.status(200).send("Registered!");
  } catch (err) { res.status(500).send(err.message); }
});

// API lấy dữ liệu ĐÃ KHỚP VỊ TRÍ
app.get('/get-map-data', async (req, res) => {
  try {
    // Lấy dữ liệu mới nhất của mỗi thiết bị và nối với bảng vị trí
    const result = await pool.query(`
      SELECT DISTINCT ON (l.device_id) l.device_id, l.temp, l.mq135, l.created_at, r.lat, r.lon, r.location_name
      FROM air_quality_logs l
      JOIN device_registry r ON l.device_id = r.device_id
      ORDER BY l.device_id, l.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/update-sensor', async (req, res) => {
  const { deviceId, temp, humid, mq135 } = req.body;
  await pool.query(`INSERT INTO air_quality_logs (device_id, temp, humid, mq135) VALUES ($1, $2, $3, $4)`, [deviceId, temp, humid, mq135]);
  res.status(200).send("Saved!");
});

app.delete('/clear', async (req, res) => {
  await pool.query('DELETE FROM air_quality_logs');
  res.send("Cleared");
});

app.listen(process.env.PORT || 3000);
