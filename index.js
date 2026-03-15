const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static('.'));

// Kết nối tới Database của bạn trên Render
const connectionString = "postgresql://aqi_system_user:uYgQokcxGdGplUFLxstVfth6cVkcRBU6@dpg-d6rckes50q8c73c096l0-a.singapore-postgres.render.com/aqi_system";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

// 1. KHỞI TẠO DATABASE (Tạo 2 bảng nếu chưa có)
const initDb = async () => {
  try {
    // Bảng lưu vị trí thiết bị (Registry)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_registry (
        device_id VARCHAR(50) PRIMARY KEY,
        lat FLOAT NOT NULL,
        lon FLOAT NOT NULL,
        location_name TEXT
      );
    `);
    // Bảng lưu lịch sử cảm biến (Logs)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS air_quality_logs (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(50),
        temp FLOAT,
        humid FLOAT,
        mq135 FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("--- Hệ thống Database đã sẵn sàng ---");
  } catch (err) {
    console.error("Lỗi khởi tạo DB:", err);
  }
};
initDb();

// 2. GIAO DIỆN NGƯỜI DÙNG
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 3. API ĐĂNG KÝ VỊ TRÍ (Lưu hoặc cập nhật vị trí thiết bị)
app.post('/register-device', async (req, res) => {
  const { deviceId, lat, lon, locationName } = req.body;
  try {
    const query = `
      INSERT INTO device_registry (device_id, lat, lon, location_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (device_id) 
      DO UPDATE SET lat = $2, lon = $3, location_name = $4;
    `;
    await pool.query(query, [deviceId, lat, lon, locationName]);
    res.status(200).send("Đã lưu vị trí thiết bị!");
  } catch (err) {
    res.status(500).send("Lỗi đăng ký: " + err.message);
  }
});

// 4. API NHẬN DỮ LIỆU CẢM BIẾN (Từ ESP8266 gửi lên)
app.post('/update-sensor', async (req, res) => {
  const { deviceId, temp, humid, mq135 } = req.body;
  try {
    const query = `INSERT INTO air_quality_logs (device_id, temp, humid, mq135) VALUES ($1, $2, $3, $4)`;
    await pool.query(query, [deviceId, temp, humid, mq135]);
    console.log(`Dữ liệu mới từ: ${deviceId}`);
    res.status(200).send("OK");
  } catch (err) {
    res.status(500).send("Lỗi lưu logs");
  }
});

// 5. API LẤY DỮ LIỆU TỔNG HỢP CHO BẢN ĐỒ (JOIN 2 bảng)
app.get('/get-map-data', async (req, res) => {
  try {
    // Lấy tất cả thiết bị đã đăng ký vị trí kèm theo dữ liệu cảm biến mới nhất của chúng
    const query = `
      SELECT DISTINCT ON (r.device_id) 
             r.device_id, r.lat, r.lon, r.location_name,
             l.temp, l.mq135, l.created_at
      FROM device_registry r
      LEFT JOIN air_quality_logs l ON r.device_id = l.device_id
      ORDER BY r.device_id, l.created_at DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. XÓA DỮ LIỆU LỊCH SỬ
app.delete('/clear-logs', async (req, res) => {
  try {
    await pool.query('DELETE FROM air_quality_logs');
    res.send("Đã xóa sạch lịch sử đo.");
  } catch (err) {
    res.status(500).send("Lỗi khi xóa.");
  }
});

// 7. API XÓA MỘT TRẠM CỤ THỂ
app.delete('/delete-device/:id', async (req, res) => {
  const deviceId = req.params.id;
  try {
    // Xóa lịch sử đo của trạm này trước (để làm sạch dữ liệu hoàn toàn)
    await pool.query('DELETE FROM air_quality_logs WHERE device_id = $1', [deviceId]);

    // Sau đó xóa trạm khỏi danh sách định vị (Registry)
    await pool.query('DELETE FROM device_registry WHERE device_id = $1', [deviceId]);

    res.status(200).send("Đã xóa trạm thành công!");
  } catch (err) {
    res.status(500).send("Lỗi khi xóa trạm: " + err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server đang chạy...");
});
