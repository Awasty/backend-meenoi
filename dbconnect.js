const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: "202.28.34.203",
  user: "mb68_65011212085",
  password: "b3fRnTs%Sik&",
  database: "mb68_65011212085",
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  
  // ค่านี้ดีมากครับ ช่วยได้เยอะ
  enableKeepAlive: true,
  keepAliveInitialDelay: 0, // เริ่ม KeepAlive ทันที

  charset: "utf8mb4",
  multipleStatements: true,
  connectTimeout: 10000,
});

db.getConnection()
  .then(conn => {
    console.log("✅ MySQL Pool connected successfully (initial test).");
    conn.release();
  })
  .catch(err => {
    console.error("❌ Failed to create MySQL Pool:", err.code, err.message);
  });

module.exports = db;
