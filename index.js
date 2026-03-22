const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static('.'));

// Kết nối tới Database trên Render
const connectionString = "postgresql://aqi_system_user:uYgQokcxGdGplUFLxstVfth6cVkcRBU6@dpg-d6rckes50q8c73c096l0-a.singapore-postgres.render.com/aqi_system";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

// ── BẢNG ĐIỂM GÃY AQI (Breakpoints) ──────────────────────────────────────────
const breakpoints = {
  // PM2.5 đã bị loại bỏ khỏi thiết bị phần cứng
  co: [
    { cLow: 0,    cHigh: 10,  iLow: 0,   iHigh: 50  },
    { cLow: 10.1, cHigh: 30,  iLow: 51,  iHigh: 100 },
    { cLow: 30.1, cHigh: 45,  iLow: 101, iHigh: 150 },
    { cLow: 45.1, cHigh: 60,  iLow: 151, iHigh: 200 },
    { cLow: 60.1, cHigh: 90,  iLow: 201, iHigh: 300 },
    { cLow: 90.1, cHigh: 150, iLow: 301, iHigh: 500 }
  ]
};

// Hàm nội suy tuyến tính tính AQI thành phần
function calculateSubAQI(concentration, type) {
  if (!concentration || concentration < 0) return 0;
  const bps = breakpoints[type];
  for (let bp of bps) {
    if (concentration >= bp.cLow && concentration <= bp.cHigh) {
      const aqi = ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (concentration - bp.cLow) + bp.iLow;
      return Math.round(aqi);
    }
  }
  return 500; // Vượt ngưỡng tối đa
}

// 1. KHỞI TẠO DATABASE
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_registry (
        device_id VARCHAR(50) PRIMARY KEY,
        lat FLOAT NOT NULL,
        lon FLOAT NOT NULL,
        location_name TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS air_quality_logs (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(50),
        temp FLOAT,
        humid FLOAT,
        pm25 FLOAT,
        co_ppm FLOAT,
        aqi INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ALTER TABLE để thêm cột mới nếu bảng cũ đã tồn tại
    await pool.query(`ALTER TABLE air_quality_logs ADD COLUMN IF NOT EXISTS pm25 FLOAT;`);
    await pool.query(`ALTER TABLE air_quality_logs ADD COLUMN IF NOT EXISTS co_ppm FLOAT;`);
    await pool.query(`ALTER TABLE air_quality_logs ADD COLUMN IF NOT EXISTS aqi INTEGER;`);
    await pool.query(`ALTER TABLE air_quality_logs ADD COLUMN IF NOT EXISTS humid FLOAT;`);
    await pool.query(`ALTER TABLE air_quality_logs ADD COLUMN IF NOT EXISTS mq135 FLOAT;`);
    await pool.query(`ALTER TABLE air_quality_logs ADD COLUMN IF NOT EXISTS mq2 FLOAT;`);

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

// 3. API ĐĂNG KÝ VỊ TRÍ
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
// ESP8266 cần gửi JSON: { deviceId, temp, humid, pm25, co, mq135, mq2 }
// pm25 (ug/m3), co (ppm)
app.post('/update-sensor', async (req, res) => {
  const { deviceId, temp, humid, co, mq135, mq2 } = req.body;

  if (!deviceId) return res.status(400).send("Thiếu deviceId");

  try {
    const val_co_ppm = parseFloat(co) || 0;
    const val_mq135  = parseFloat(mq135) || 0;
    const val_mq2    = parseFloat(mq2) || 0;

    // Chuyển đổi CO từ ppm sang mg/m3 theo công thức chuẩn
    const val_co_mgm3 = val_co_ppm * 1.15;

    // Tính điểm AQI thành phần cho CO (Dùng thay thế cho bụi mịn đã bỏ)
    const final_aqi = calculateSubAQI(val_co_mgm3, 'co');

    const query = `
      INSERT INTO air_quality_logs (device_id, temp, humid, co_ppm, mq135, mq2, aqi)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await pool.query(query, [deviceId, temp, humid, val_co_ppm, val_mq135, val_mq2, final_aqi]);

    console.log(`[+] ${deviceId} | Temp: ${temp}°C | Humid: ${humid}% | CO: ${val_co_ppm} | MQ135: ${val_mq135} | MQ2: ${val_mq2} | AQI: ${final_aqi}`);
    res.status(200).json({ status: "OK", aqi: final_aqi });

  } catch (err) {
    console.error("Lỗi lưu logs:", err);
    res.status(500).send("Lỗi lưu logs");
  }
});

// 5. API LẤY DỮ LIỆU TỔNG HỢP CHO BẢN ĐỒ (JOIN 2 bảng)
app.get('/get-map-data', async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT ON (r.device_id)
             r.device_id, r.lat, r.lon, r.location_name,
             l.temp, l.humid, l.co_ppm, l.mq135, l.mq2, l.aqi, l.created_at
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

// 6. XÓA LỊCH SỬ ĐO
app.delete('/clear-logs', async (req, res) => {
  try {
    await pool.query('DELETE FROM air_quality_logs');
    res.send("Đã xóa sạch lịch sử đo.");
  } catch (err) {
    res.status(500).send("Lỗi khi xóa.");
  }
});

// 7. XÓA MỘT TRẠM CỤ THỂ
app.delete('/delete-device/:id', async (req, res) => {
  const deviceId = req.params.id;
  try {
    await pool.query('DELETE FROM air_quality_logs WHERE device_id = $1', [deviceId]);
    await pool.query('DELETE FROM device_registry WHERE device_id = $1', [deviceId]);
    res.status(200).send("Đã xóa trạm thành công!");
  } catch (err) {
    res.status(500).send("Lỗi khi xóa trạm: " + err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server đang chạy...");
});
