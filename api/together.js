const express = require("express");
const db = require("../dbconnect"); // mysql2/promise db
const router = express.Router();
const bcrypt = require("bcrypt");

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

router.post("/login", async (req, res) => {
  const { phone, password } = req.body || {};

  if (!phone || !password) {
    return res.status(400).json({
      status: false,
      message: "กรุณากรอก phone และ password",
    });
  }

  const p = phone.trim();

  try {
    const conn = await db.getConnection();
    try {
      // 1) หาจากตาราง user ก่อน (คอลัมน์เท่าที่จำเป็น)
      let [rows] = await conn.query(
        `SELECT 'user' AS role, uid, phone, password, name, image
           FROM user
          WHERE phone = ? 
          LIMIT 1`,
        [p]
      );

      // 2) ถ้าไม่เจอ ลองหาจากตาราง rider และ alias rid -> uid
      if (rows.length === 0) {
        [rows] = await conn.query(
          `SELECT 'rider' AS role, rid AS uid, phone, password, name, image
             FROM rider
            WHERE phone = ?
            LIMIT 1`,
          [p]
        );
      }

      if (rows.length === 0) {
        return res.status(401).json({
          status: false,
          message: "เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง",
        });
      }

      const account = rows[0]; // { role, uid, phone, password, name, image }
      const ok = await bcrypt.compare(password, account.password);
      if (!ok) {
        return res.status(401).json({
          status: false,
          message: "เบอร์โทรและรหัสผ่านไม่ถูกต้อง",
        });
      }

      // ✅ Normalize response: ใช้คีย์ชุดเดียวกันเสมอ
      return res.status(200).json({
        status: true,
        message: "เข้าสู่ระบบสำเร็จ",
        data: {
          user_type: account.role, // "user" | "rider"
          uid: account.uid, // ✅ rider.rid ถูก map มาเป็น uid แล้ว
          phone: account.phone,
          name: account.name,
          image: account.image ?? null, // เผื่อบางแถวเป็น NULL
          // ถ้าต้องการตำแหน่ง/เวลาในอนาคต ค่อยเติม latitude/longitude/last_seen ทีหลัง
        },
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: false,
      message: "เกิดข้อผิดพลาดภายในระบบ",
    });
  }
});

module.exports = router;
