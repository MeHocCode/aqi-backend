const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.json());

// Thông tin kết nối lấy từ Render của bạn
const connectionString = "postgresql://aqi_system_user:uYgQokcxGdGplUFLxstVfth6cVkcRBU6@dpg-d6rckes50q8c73c096l0-a.singapore-postgres.render.com/aqi_system";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

// Hàm này sẽ tự chạy để tạo bảng nếu DB của bạn đang trống
const initDb = async () => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS air_quality_logs (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(50),
        temp FLOAT,
        humid FLOAT,
        mq2 FLOAT,
        mq7 FLOAT,
        mq135 FLOAT,
        dust FLOAT,
        lat FLOAT,
        lon FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(createTableQuery);
    console.log("--- DATABASE: Bảng air_quality_logs đã sẵn sàng! ---");
  } catch (err) {
    console.error("--- DATABASE ERROR: ---", err);
  }
};

initDb();

app.get('/', (req, res) => res.send("AQI Server đang hoạt động! Chờ dữ liệu từ ESP8266..."));

// Đường dẫn đón dữ liệu từ ESP8266
app.post('/update-sensor', async (req, res) => {
  const { deviceId, temp, humid, mq2, mq7, mq135, dust, lat, lon } = req.body;
  try {
    const query = `
      INSERT INTO air_quality_logs (device_id, temp, humid, mq2, mq7, mq135, dust, lat, lon)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    await pool.query(query, [deviceId, temp, humid, mq2, mq7, mq135, dust, lat, lon]);
    console.log(`Đã nhận dữ liệu từ: ${deviceId}`);
    res.status(200).send("Saved!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000);
