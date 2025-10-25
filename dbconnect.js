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
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: "utf8mb4",
  multipleStatements: true,
  connectTimeout: 10000, // เพิ่มเวลาการเชื่อมต่อเป็น 10 วินาที
});

// ฟังก์ชันที่เชื่อมต่อฐานข้อมูลพร้อมการ retry
async function connectToDatabase(retryCount = 0) {
  try {
    const conn = await db.getConnection();
    console.log("✅ Connected to MySQL database.");
    conn.release(); // release connection after testing
    return conn;
  } catch (err) {
    console.error(
      `❌ Connection attempt ${retryCount + 1} failed:`,
      err.code,
      err.message
    );

    if (retryCount < 3) {
      // Retry up to 3 times
      console.log("Retrying connection...");
      return connectToDatabase(retryCount + 1);
    } else {
      console.error(
        "❌ Max retries reached. Could not connect to the database."
      );
      throw new Error("Unable to connect to the database after 3 attempts");
    }
  }
}

// ทดสอบการเชื่อมต่อครั้งแรก
(async () => {
  try {
    await connectToDatabase();
  } catch (err) {
    console.error("Database connection failed after multiple attempts:", err);
  }
})();

module.exports = db;
