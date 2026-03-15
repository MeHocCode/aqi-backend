const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
app.use(express.json());

const connectionString = "postgresql://aqi_system_user:uYgQokcxGdGplUFLxstVfth6cVkcRBU6@dpg-d6rckes50q8c73c096l0-a.singapore-postgres.render.com/aqi_system";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

// Trang chủ trả về giao diện HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API lấy dữ liệu đổ lên bản đồ và bảng
app.get('/get-data', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM air_quality_logs ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Lỗi DB" });
  }
});

// API nhận dữ liệu từ ESP8266 hoặc từ Form trên Web
app.post('/update-sensor', async (req, res) => {
  const { deviceId, temp, humid, mq135, dust, lat, lon } = req.body;
  try {
    const query = `INSERT INTO air_quality_logs (device_id, temp, humid, mq135, dust, lat, lon) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    await pool.query(query, [deviceId, temp, humid, mq135, dust, lat, lon]);
    res.status(200).send("Saved!");
  } catch (err) {
    res.status(500).send("Error");
  }
});

// API XÓA SẠCH DỮ LIỆU (Mới thêm)
app.delete('/delete-all', async (req, res) => {
  try {
    await pool.query('DELETE FROM air_quality_logs');
    res.status(200).send("Cleaned!");
  } catch (err) {
    res.status(500).send("Fail");
  }
});

app.listen(process.env.PORT || 3000);
