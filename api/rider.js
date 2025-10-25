const express = require("express");
const db = require("../dbconnect"); // mysql2/promise pool
const router = express.Router();
const bcrypt = require("bcrypt");

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// utility เล็กๆ
const SALT_ROUNDS = 10;
const nowUtc = () => new Date(new Date().toISOString()); // ISO -> Date

// ---------- POST /register/rider ----------
// body: { phone, password, name, image?, vehicle_image?, license_plate }
router.post("/register", async (req, res) => {
  const { phone, password, name, image, vehicle_image, license_plate } =
    req.body || {};

  // ตรวจสอบข้อมูล
  if (!phone || !password || !name || !license_plate) {
    return res.status(400).json({
      status: false,
      message: "กรุณากรอก phone, password, name และ license_plate ให้ครบ",
    });
  }

  try {
    const conn = await db.getConnection();
    try {
      // ตรวจเบอร์ซ้ำใน rider
      const [dupPhone] = await conn.query(
        "SELECT rid FROM rider WHERE phone = ? LIMIT 1",
        [phone.trim()]
      );
      if (dupPhone.length > 0) {
        return res.status(409).json({
          status: false,
          message: "เบอร์โทรนี้มีไรเดอร์ใช้งานแล้ว",
        });
      }

      // ตรวจทะเบียนรถซ้ำใน rider
      const [dupPlate] = await conn.query(
        "SELECT rid FROM rider WHERE license_plate = ? LIMIT 1",
        [license_plate.trim().toUpperCase()]
      );
      if (dupPlate.length > 0) {
        return res.status(409).json({
          status: false,
          message: "ทะเบียนรถนี้ถูกลงทะเบียนแล้ว",
        });
      }

      // แฮชรหัสผ่าน
      const hash = await bcrypt.hash(password, SALT_ROUNDS);

      // บันทึก (ค่าเริ่มต้นบางตัว)
      const is_available = 1; // ออนไลน์พร้อมรับงานเริ่มต้น (ปรับตามนโยบายได้)
      const latitude = null;
      const longitude = null;
      const last_seen = nowUtc();

      const [result] = await conn.query(
        `INSERT INTO rider
         (phone, password, name, image, vehicle_image, license_plate, is_available, latitude, longitude, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          phone.trim(),
          hash,
          name.trim(),
          image || null,
          vehicle_image || null,
          license_plate.trim().toUpperCase(),
          is_available,
          latitude,
          longitude,
          last_seen,
        ]
      );

      return res.status(201).json({
        status: true,
        message: "สมัครสมาชิก (rider) สำเร็จ",
        data: {
          rid: result.insertId,
          phone: phone.trim(),
          name: name.trim(),
          image: image || null,
          vehicle_image: vehicle_image || null,
          license_plate: license_plate.trim().toUpperCase(),
          is_available,
          last_seen,
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

router.get("/shipment-show", async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    try {
      // 1. ค้นหางานที่ rid IS NULL และสถานะ "รอไรเดอร์มารับสินค้า"
      // 2. JOIN ตาราง user เพื่อเอาชื่อ sender
      // (สันนิษฐานว่า ตาราง shipment มีคอลัมน์ sender_uid ที่เชื่อมกับ user.uid)
      const query = `
        SELECT 
          s.sid,
          s.name,
          s.description,
          u.name AS sender_name 
        FROM 
          shipment AS s
        JOIN 
          user AS u ON s.sender_uid = u.uid
        WHERE 
          s.rid IS NULL 
          AND s.status = 'รอไรเดอร์มารับสินค้า'
        ORDER BY 
          s.created_at DESC;
      `;

      const [rows] = await conn.query(query);

      // 3. จัดรูปแบบข้อมูลให้ตรงกับที่ Model ใน Flutter คาดหวัง
      // (คือมี object sender ซ้อนอยู่ข้างใน)
      const jobs = rows.map((row) => {
        return {
          sid: row.sid,
          name: row.name,
          description: row.description,
          sender: {
            name: row.sender_name,
          },
        };
      });

      return res.status(200).json({
        status: "success", // <-- [FIXED] เปลี่ยนจาก true (boolean) เป็น "success" (string)
        message: "ดึงข้อมูลงานที่พร้อมให้บริการสำเร็จ",
        data: jobs,
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    // ตรวจสอบว่า conn ถูก assign ค่าหรือยังก่อน release
    if (conn) conn.release();
    return res.status(500).json({
      status: "error", // <-- [FIXED] เปลี่ยนจาก false (boolean) เป็น "error" (string)
      message: "เกิดข้อผิดพลาดภายในระบบ",
    });
  }
});

router.post("/shipment-accept", async (req, res) => {
  const { sid, rid } = req.body;
  console.log("sid ", sid);
  if (!sid || !rid) {
    return res.status(400).json({
      status: "error",
      message: "กรุณาส่ง SID และ RID ให้ครบถ้วน",
    });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction(); // เริ่ม Transaction

    try {
      // 1. ตรวจสอบสถานะงานก่อน (ล็อคแถวเพื่อป้องกัน Race Condition)
      const [currentShipment] = await conn.query(
        "SELECT rid, status FROM shipment WHERE sid = ? FOR UPDATE",
        [sid]
      );

      if (currentShipment.length === 0) {
        await conn.rollback();
        return res.status(404).json({
          status: "error",
          message: "ไม่พบงานที่ระบุ (SID)",
        });
      }

      // 2. เช็กว่ามีคนรับไปหรือยัง
      if (currentShipment[0].rid != null) {
        await conn.rollback();
        return res.status(409).json({
          // 409 Conflict
          status: "error",
          message: "งานนี้ถูกไรเดอร์ท่านอื่นรับไปแล้ว",
        });
      }

      // 3. เช็กสถานะ (ต้องเป็น 'รอไรเดอร์มารับสินค้า' เท่านั้น)
      if (currentShipment[0].status !== "รอไรเดอร์มารับสินค้า") {
        await conn.rollback();
        return res.status(409).json({
          status: "error",
          message: `สถานะงานไม่ถูกต้อง (สถานะปัจจุบัน: ${currentShipment[0].status})`,
        });
      }

      // --- [NEW] ---
      // 4. ตรวจสอบว่า Rider ว่างหรือไม่
      const [riderStatus] = await conn.query(
        "SELECT is_available FROM rider WHERE rid = ? FOR UPDATE", // ล็อค Rider ด้วย
        [rid]
      );

      if (riderStatus.length === 0) {
        await conn.rollback();
        return res.status(404).json({
          status: "error",
          message: "ไม่พบข้อมูลไรเดอร์",
        });
      }

      if (riderStatus[0].is_available !== 0) {
        await conn.rollback();
        return res.status(409).json({
          status: "error",
          message: "คุณกำลังมีงานอื่นอยู่ ไม่สามารถรับงานซ้อนได้",
        });
      }
      // --- [END NEW] ---

      // 5. อัปเดต Shipment Table (เดิมคือ 4)
      const newStatus = "ไรเดอร์กำลังเดินทางมารับสินค้า"; // สถานะใหม่
      const acceptedAt = new Date(new Date().toISOString()); // เวลาที่กดยอมรับ (UTC)

      const [updateShipmentResult] = await conn.query(
        // เปลี่ยนชื่อตัวแปร
        `UPDATE shipment
         SET rid = ?, status = ?, accepted_at = ?
         WHERE sid = ? AND rid IS NULL`, // อัปเดตเฉพาะถ้า rid ยังเป็น null (ป้องกันอีกชั้น)
        [rid, newStatus, acceptedAt, sid]
      );

      // 6. ตรวจสอบว่าอัปเดต Shipment สำเร็จจริง (เดิมคือ 5)
      if (updateShipmentResult.affectedRows === 0) {
        await conn.rollback();
        return res.status(409).json({
          status: "error",
          message: "งานนี้ถูกรับไปแล้ว (Transaction conflict)",
        });
      }

      // --- [NEW] ---
      // 7. อัปเดตสถานะ Rider ให้ไม่ว่าง
      await conn.query(`UPDATE rider SET is_available = 1 WHERE rid = ?`, [
        rid,
      ]);
      // --- [END NEW] ---

      // 8. เพิ่ม Log สถานะในตาราง status_log (เดิมคือ 6)
      // (สันนิษฐานว่ามีตาราง status_log ที่มีคอลัมน์ sid, status, photo, role, rid)
      // [--- MODIFIED ---] เพิ่ม role และ rid ใน status_log
      await conn.query(
        `INSERT INTO status_log (sid, status, photo, role)
         VALUES (?, ?, ?, ?)`,
        [sid, newStatus, null, "rider"] // เพิ่ม role='rider' และ rid
      );

      // --- [NEW] ---
      // 9. เพิ่มข้อมูลในตาราง Assignment
      const assignmentCreatedAt = acceptedAt; // ใช้เวลาเดียวกับ accepted_at
      await conn.query(
        `INSERT INTO assignment (sid, rid, created_at) VALUES (?, ?, ?)`,
        [sid, rid, assignmentCreatedAt]
      );
      // --- [END NEW] ---

      // 10. ยืนยัน Transaction (Commit) (เดิมคือ 7)
      await conn.commit();

      // ส่ง Response สำเร็จกลับไป
      return res.status(200).json({
        status: "success",
        message: "รับงานสำเร็จ",
        data: {
          sid: sid,
          rid: rid,
          newStatus: newStatus,
          acceptedAt: acceptedAt,
        },
      });
    } catch (err) {
      // Catch error ระหว่าง Transaction
      await conn.rollback(); // Rollback ถ้ามี error
      throw err; // โยน error ให้ catch ด้านนอกจัดการต่อ
    } finally {
      if (conn) {
        // ตรวจสอบก่อน release
        conn.release();
      }
    }
  } catch (err) {
    // Catch error ตอน connect หรือตอนโยนมาจากข้างใน
    console.error("Error in /rider/shipment-accept:", err);
    if (conn) {
      // ตรวจสอบก่อน release (เผื่อ connect ได้แต่พังทีหลัง)
      conn.release();
    }
    return res.status(500).json({
      status: "error",
      message: "เกิดข้อผิดพลาดภายในระบบ (Accept Job)",
    });
  }
});

// ไรเดอร์กดอัปเดตสถานะ (เช่น รับของแล้ว, ส่งของแล้ว)
router.post("/update-status", async (req, res) => {
  const { sid, rid, status: newStatus, photo } = req.body;

  // --- Validation ---
  if (!sid || !rid || !newStatus) {
    return res.status(400).json({
      status: "error",
      message: "กรุณาส่ง SID, RID, และ Status ใหม่ให้ครบถ้วน",
    });
  }

  // กำหนดสถานะที่ Rider สามารถอัปเดตได้ และสถานะก่อนหน้า
  const allowedTransitions = {
    ไรเดอร์รับสินค้าแล้วและกำลังเดินทางไปส่ง: "ไรเดอร์กำลังเดินทางมารับสินค้า",
    ไรเดอร์นำส่งสินค้าแล้ว: "ไรเดอร์รับสินค้าแล้วและกำลังเดินทางไปส่ง",
  };

  if (!allowedTransitions[newStatus]) {
    return res.status(400).json({
      status: "error",
      message: `สถานะ "${newStatus}" ไม่ถูกต้องหรือไม่ได้รับอนุญาตให้อัปเดต`,
    });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      // 1. ตรวจสอบ Shipment และ Rider ที่ Assigned (Lock row)
      const [shipment] = await conn.query(
        "SELECT rid, status FROM shipment WHERE sid = ? FOR UPDATE",
        [sid]
      );

      if (shipment.length === 0)
        throw { status: 404, message: "ไม่พบงานที่ระบุ (SID)" };
      if (shipment[0].rid != rid)
        // ใช้ != แทน !== เพราะ rid จาก DB อาจเป็น number
        throw { status: 403, message: "คุณไม่ใช่ไรเดอร์ที่รับผิดชอบงานนี้" };

      // 2. ตรวจสอบลำดับสถานะ
      const expectedPreviousStatus = allowedTransitions[newStatus];
      if (shipment[0].status !== expectedPreviousStatus) {
        throw {
          status: 409,
          message: `สถานะปัจจุบัน (${shipment[0].status}) ไม่ถูกต้องสำหรับการอัปเดตเป็น "${newStatus}"`,
        };
      }

      // 3. เตรียมข้อมูลเวลา
      const now = nowUtc();
      let updateFields = "status = ?";
      let updateValues = [newStatus];

      if (newStatus === "ไรเดอร์รับสินค้าแล้วและกำลังเดินทางไปส่ง") {
        updateFields += ", picked_up_at = ?";
        updateValues.push(now);
      } else if (newStatus === "ไรเดอร์นำส่งสินค้าแล้ว") {
        updateFields += ", delivered_at = ?";
        updateValues.push(now);
      }
      updateValues.push(sid); // สำหรับ WHERE clause
      updateValues.push(rid); // สำหรับ WHERE clause

      // 4. อัปเดต Shipment
      const [updateShipmentResult] = await conn.query(
        `UPDATE shipment SET ${updateFields} WHERE sid = ? AND rid = ?`,
        updateValues
      );

      if (updateShipmentResult.affectedRows === 0) {
        throw { status: 500, message: "เกิดข้อผิดพลาดในการอัปเดต Shipment" };
      }

      // 5. เพิ่ม Status Log
      await conn.query(
        `INSERT INTO status_log (sid, status, photo, role) VALUES (?, ?, ?, ?)`,
        [sid, newStatus, photo || null, "rider"] // เพิ่ม rid ใน log ด้วย
      );

      // 6. ถ้าเป็นสถานะ "ส่งสำเร็จ" -> อัปเดต Rider ให้ว่าง และปิด Assignment
      let assignmentClosed = false;
      if (newStatus === "ไรเดอร์นำส่งสินค้าแล้ว") {
        // [--- FIXED ---] ทำให้ Rider กลับมาว่าง (is_available = 0)
        await conn.query(`UPDATE rider SET is_available = 0 WHERE rid = ?`, [
          rid,
        ]); // 0 คือ ว่าง
        // --- [END FIXED] ---

        // ปิด Assignment โดยใส่ released_at
        const [updateAssignmentResult] = await conn.query(
          `UPDATE assignment SET released_at = ? WHERE sid = ? AND rid = ? AND released_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [now, sid, rid]
        );
        assignmentClosed = updateAssignmentResult.affectedRows > 0;
      }

      // 7. Commit Transaction
      await conn.commit();

      return res.status(200).json({
        status: "success",
        message: `อัปเดตสถานะเป็น "${newStatus}" สำเร็จ`,
        data: {
          sid,
          rid,
          newStatus: newStatus,
          timestamp: now,
          assignmentClosed: assignmentClosed,
        },
      });
    } catch (err) {
      await conn.rollback();
      console.error("Transaction Error in /rider/update-status:", err);
      if (err.status) {
        return res
          .status(err.status)
          .json({ status: "error", message: err.message });
      } else {
        return res.status(500).json({
          status: "error",
          message: "เกิดข้อผิดพลาดภายในระบบขณะอัปเดตสถานะ",
        });
      }
    } finally {
      if (conn) conn.release();
    }
  } catch (err) {
    console.error("Error in /rider/update-status (Outer Catch):", err);
    if (conn) conn.release();
    return res.status(500).json({
      status: "error",
      message: "เกิดข้อผิดพลาดภายในระบบ (Update Status Setup)",
    });
  }
});

// --- [THIS IS THE NEW ROUTE YOU ASKED FOR] ---
/**
 * POST /rider/current-job
 * ค้นหางานปัจจุบันที่ Rider กำลังทำอยู่ (ยังไม่เสร็จสิ้น)
 * body: { rid }
 */
router.post("/current-job", async (req, res) => {
  const { rid } = req.body;
  if (!rid) {
    return res
      .status(400)
      .json({ status: "error", message: "กรุณาส่ง RID ให้ครบถ้วน" });
  }

  let conn;
  try {
    conn = await db.getConnection();
    try {
      // ค้นหางานล่าสุดที่ Rider คนนี้รับ (rid ตรงกัน)
      // และยังไม่เสร็จ (สถานะไม่ใช่ 'ไรเดอร์นำส่งสินค้าแล้ว')
      // และ Assignment ยังไม่ถูกปิด (released_at IS NULL)
      const query = `
                SELECT
                    s.sid
                FROM
                    shipment s
                JOIN
                    assignment a ON s.sid = a.sid AND s.rid = a.rid
                WHERE
                    s.rid = ?
                    AND s.status != 'ไรเดอร์นำส่งสินค้าแล้ว'
                    AND a.released_at IS NULL
                ORDER BY
                    a.created_at DESC
                LIMIT 1;
            `;
      const [rows] = await conn.query(query, [rid]);

      if (rows.length > 0) {
        // เจอ SID ของงานที่กำลังทำอยู่
        return res.status(200).json({
          status: "success",
          message: "พบงานที่กำลังดำเนินการอยู่",
          data: { sid: rows[0].sid },
        });
      } else {
        // ไม่เจอ (อาจจะไม่มีงาน หรือทำงานเสร็จหมดแล้ว)
        return res.status(200).json({
          // ใช้ 200 OK แต่ data เป็น null
          status: "success",
          message: "ไม่พบงานที่กำลังดำเนินการอยู่สำหรับ Rider นี้",
          data: null, // ส่ง null กลับไปบอก Frontend ว่าไม่มีงาน active
        });
      }
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("Error in /rider/current-job:", err);
    if (conn) conn.release();
    return res.status(500).json({
      status: "error",
      message: "เกิดข้อผิดพลาดภายในระบบ (Current Job)",
    });
  }
});

router.post("/rider/update-location", async (req, res) => {
  const { rid, latitude, longitude } = req.body;

  if (rid == null || latitude == null || longitude == null) {
    return res.status(400).json({
      status: "error",
      message: "กรุณาส่ง rid, latitude, และ longitude ให้ครบถ้วน",
    });
  }

  let conn;
  try {
    conn = await db.getConnection();
    try {
      const now = nowUtc(); // เวลาปัจจุบัน UTC

      const [result] = await conn.query(
        `UPDATE rider
                 SET latitude = ?, longitude = ?, last_seen = ?
                 WHERE rid = ?`,
        [latitude, longitude, now, rid]
      );

      if (result.affectedRows > 0) {
        return res.status(200).json({
          status: "success",
          message: "อัปเดตตำแหน่งสำเร็จ",
        });
      } else {
        // ไม่พบ Rider ID ที่ส่งมา
        return res.status(404).json({
          status: "error",
          message: "ไม่พบ Rider ที่ระบุ",
        });
      }
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("Error updating rider location:", err);
    if (conn) conn.release(); // Ensure connection is released on error
    return res.status(500).json({
      status: "error",
      message: "เกิดข้อผิดพลาดภายในระบบ (Update Location)",
    });
  }
});

module.exports = router;
