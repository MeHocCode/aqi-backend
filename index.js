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

// ── BẢNG ĐIỂM GÃY AQI TÙY CHỈNH (Dựa trên giá trị RAW của cảm biến) ────────────────
const breakpoints = {
  mq2: [
    { cLow: 0,     cHigh: 170,  iLow: 0,   iHigh: 50  }, // Tốt
    { cLow: 170.1, cHigh: 250,  iLow: 51,  iHigh: 100 }, // Trung bình
    { cLow: 250.1, cHigh: 350,  iLow: 101, iHigh: 150 }, // Kém
    { cLow: 350.1, cHigh: 500,  iLow: 151, iHigh: 200 }, // Xấu
    { cLow: 500.1, cHigh: 700,  iLow: 201, iHigh: 300 }, // Rất Xấu
    { cLow: 700.1, cHigh: 1024, iLow: 301, iHigh: 500 }  // Nguy Hại
  ],
  co: [
    { cLow: 0,     cHigh: 50,   iLow: 0,   iHigh: 50  }, // Tốt
    { cLow: 50.1,  cHigh: 100,  iLow: 51,  iHigh: 100 }, // Trung bình
    { cLow: 100.1, cHigh: 200,  iLow: 101, iHigh: 150 }, // Kém
    { cLow: 200.1, cHigh: 400,  iLow: 151, iHigh: 200 }, // Xấu
    { cLow: 400.1, cHigh: 700,  iLow: 201, iHigh: 300 }, // Rất Xấu
    { cLow: 700.1, cHigh: 1024, iLow: 301, iHigh: 500 }  // Nguy Hại
  ],
  mq135: [
    { cLow: 0,     cHigh: 200,  iLow: 0,   iHigh: 50  }, // Tốt
    { cLow: 200.1, cHigh: 350,  iLow: 51,  iHigh: 100 }, // Trung bình
    { cLow: 350.1, cHigh: 500,  iLow: 101, iHigh: 150 }, // Kém
    { cLow: 500.1, cHigh: 700,  iLow: 151, iHigh: 200 }, // Xấu
    { cLow: 700.1, cHigh: 850,  iLow: 201, iHigh: 300 }, // Rất Xấu
    { cLow: 850.1, cHigh: 1024, iLow: 301, iHigh: 500 }  // Nguy Hại
  ]
};

// Hàm tính AQI thành phần dựa trên giá trị Raw
function calculateSubAQI(concentration, type) {
  if (!concentration || concentration < 0) return 0;
  const bps = breakpoints[type];
  if (!bps) return 0;
  for (let bp of bps) {
    if (concentration >= bp.cLow && concentration <= bp.cHigh) {
      const aqi = ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (concentration - bp.cLow) + bp.iLow;
      return Math.round(aqi);
    }
  }
  return 500; 
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
    const val_co    = (parseFloat(co) || 0) / 10;
    const val_mq135 = parseFloat(mq135) || 0;
    const val_mq2   = parseFloat(mq2) || 0;

    // Tính điểm AQI thành phần dựa trên bảng giá trị Raw mới
    const aqi_mq2   = calculateSubAQI(val_mq2, 'mq2');
    const aqi_co    = calculateSubAQI(val_co, 'co');
    const aqi_mq135 = calculateSubAQI(val_mq135, 'mq135');

    // AQI tổng hợp là giá trị cao nhất (nguy hiểm nhất) trong các cảm biến
    const final_aqi = Math.max(aqi_mq2, aqi_co, aqi_mq135);

    const query = `
      INSERT INTO air_quality_logs (device_id, temp, humid, co_ppm, mq135, mq2, aqi)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await pool.query(query, [deviceId, temp, humid, val_co, val_mq135, val_mq2, final_aqi]);

    console.log(`[+] ${deviceId} | AQI: ${final_aqi} | Raw -> CO: ${val_co}, MQ135: ${val_mq135}, MQ2: ${val_mq2}`);
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
