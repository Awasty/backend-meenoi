const express = require("express");
const db = require("../dbconnect"); // mysql2/promise db
const router = express.Router();
const bcrypt = require("bcrypt");

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// utility เล็กๆ
const SALT_ROUNDS = 10;
const nowUtc = () => new Date(new Date().toISOString()); // ISO -> Date

// GET /user  -> ดึงผู้ใช้ทั้งหมด
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM user");
    res.json(rows);
  } catch (err) {
    console.error("Error executing GET /user:", err);
    res.status(500).send("Error fetching data from user table");
  }
});

// ---------- POST /register/user ----------
// body: { phone, password, name, image? }
router.post("/register", async (req, res) => {
  const { phone, password, name, image, address, latitude, longitude } =
    req.body || {};

  // ตรวจสอบข้อมูล
  if (!phone || !password || !name || !address || !latitude || !longitude) {
    return res.status(400).json({
      status: false,
      message:
        "กรุณากรอก phone, password, name, address, latitude, longitude ให้ครบ",
    });
  }

  try {
    const conn = await db.getConnection();
    try {
      // ตรวจเบอร์ซ้ำใน user
      const [dup] = await conn.query(
        "SELECT uid FROM user WHERE phone = ? LIMIT 1",
        [phone.trim()]
      );
      if (dup.length > 0) {
        return res.status(409).json({
          status: false,
          message: "เบอร์โทรนี้มีผู้ใช้งานแล้ว",
        });
      }

      // แฮชรหัสผ่าน
      const hash = await bcrypt.hash(password, SALT_ROUNDS);

      // บันทึกผู้ใช้ในตาราง user
      const [result] = await conn.query(
        `INSERT INTO user (phone, password, name, image)
         VALUES (?, ?, ?, ?)`,
        [phone.trim(), hash, name.trim(), image || null]
      );

      const uid = result.insertId;

      // บันทึกข้อมูลที่อยู่ในตาราง address
      const [addressResult] = await conn.query(
        `INSERT INTO address (uid, address_text, latitude, longitude)
         VALUES (?, ?, ?, ?)`,
        [uid, address.trim(), latitude, longitude]
      );

      return res.status(201).json({
        status: true,
        message: "สมัครสมาชิก (user) สำเร็จ",
        data: {
          uid,
          phone: phone.trim(),
          name: name.trim(),
          image: image || null,
          address: {
            address_text: address.trim(),
            latitude,
            longitude,
            aid: addressResult.insertId,
          },
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

router.get("/search/:uid", async (req, res) => {
  const { uid } = req.params; // รับ uid จาก URL params
  try {
    // ตรวจสอบว่า uid มีค่า
    if (!uid) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Execute query
    const [results] = await db.execute(
      `
      SELECT u.uid, u.phone, u.name, u.image, 
             a.aid, a.address_text, a.label, a.latitude, a.longitude, a.is_default
      FROM user u
      LEFT JOIN address a ON u.uid = a.uid
      WHERE u.uid != ? -- กรองผู้ใช้ที่ไม่ใช่ uid ที่ส่งมา
    `,
      [uid]
    ); // ใส่ uid ที่ส่งมาใน query

    if (results.length === 0) {
      return res.status(404).json({ message: "No users found" });
    }

    // จัดกลุ่มข้อมูลที่อยู่ตาม uid
    const users = [];
    let currentUser = null;

    results.forEach((row) => {
      if (!currentUser || currentUser.uid !== row.uid) {
        if (currentUser) users.push(currentUser);
        currentUser = {
          uid: row.uid,
          phone: row.phone,
          name: row.name,
          image: row.image,
          addresses: [],
        };
      }

      // เพิ่มที่อยู่ของผู้ใช้ (รวม aid)
      if (row.address_text) {
        currentUser.addresses.push({
          aid: row.aid,
          address_text: row.address_text,
          label: row.label,
          latitude: row.latitude,
          longitude: row.longitude,
          is_default: row.is_default,
        });
      }
    });

    if (currentUser) users.push(currentUser);
    res.status(200).json(users);
  } catch (err) {
    console.error("Error fetching user data:", err); // เพิ่มการแสดงข้อผิดพลาด
    res
      .status(500)
      .json({ message: "Error fetching data", error: err.message });
  }
});

router.post("/shipment_info", async (req, res) => {
  const { senderUserId, receiverUserId } = req.body;

  try {
    // ดึงข้อมูลผู้ส่งจากฐานข้อมูล
    const [senderRows] = await db.query(
      "SELECT uid, name, phone, image FROM user WHERE uid = ?",
      [senderUserId]
    );
    if (senderRows.length === 0) {
      return res.status(404).json({ message: "ไม่พบข้อมูลผู้ส่ง" });
    }

    // ดึงข้อมูลที่อยู่ทั้งหมดของผู้ส่ง
    const [senderAddressRows] = await db.query(
      "SELECT aid, label, address_text, latitude, longitude, is_default FROM address WHERE uid = ?",
      [senderUserId]
    );

    // ดึงข้อมูลผู้รับจากฐานข้อมูล
    const [receiverRows] = await db.query(
      "SELECT uid, name, phone, image FROM user WHERE uid = ?",
      [receiverUserId]
    );
    if (receiverRows.length === 0) {
      return res.status(404).json({ message: "ไม่พบข้อมูลผู้รับ" });
    }

    // ดึงข้อมูลที่อยู่ทั้งหมดของผู้รับ
    const [receiverAddressRows] = await db.query(
      "SELECT aid, label, address_text, latitude, longitude, is_default FROM address WHERE uid = ?",
      [receiverUserId]
    );

    // ส่งข้อมูลทั้งผู้ส่ง, ผู้รับ, และที่อยู่ของทั้งคู่กลับไป
    res.json({
      sender: { ...senderRows[0], addresses: senderAddressRows },
      receiver: { ...receiverRows[0], addresses: receiverAddressRows },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
  }
});

router.post("/shipment-add", async (req, res) => {
  const {
    sender_uid,
    receiver_uid,
    pickup_aid,
    delivery_aid,
    name,
    description,
    image, // รับข้อมูล image (URL)
  } = req.body;

  // ตรวจสอบให้แน่ใจว่าได้รับข้อมูลครบทุกคอลัมน์
  if (
    !sender_uid ||
    !receiver_uid ||
    !pickup_aid ||
    !delivery_aid ||
    !name ||
    !description
  ) {
    return res.status(400).json({ message: "ข้อมูลไม่ครบถ้วน" });
  }

  // ตั้งค่า status เป็น 'รอไรเดอร์มารับสินค้า' โดยอัตโนมัติ
  const status = "รอไรเดอร์มารับสินค้า";

  // ดึงเวลาปัจจุบันและแปลงเป็น UTC+7
  const moment = require("moment-timezone");
  const createdAt = moment().tz("Asia/Bangkok").format("YYYY-MM-DD HH:mm:ss");

  try {
    // สั่งให้เพิ่มข้อมูลลงในตาราง shipment
    const [result] = await db.query(
      "INSERT INTO shipment (sender_uid, receiver_uid, pickup_aid, delivery_aid, name, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        sender_uid,
        receiver_uid,
        pickup_aid,
        delivery_aid,
        name,
        description,
        status,
        createdAt, // เก็บเวลาในรูปแบบ UTC+7
      ]
    );

    // บันทึกการเปลี่ยนแปลงสถานะใน status_log
    const shipmentId = result.insertId; // id ของ shipment ที่เพิ่มใหม่
    await db.query(
      "INSERT INTO status_log (sid, status, role, photo, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        shipmentId, // ใช้ id จาก shipment
        status, // สถานะเริ่มต้น
        "system", // ใช้ "system" หรือ "user" ตามต้องการ
        image, // เก็บ URL ของภาพ
        createdAt, // ใช้เวลาเดียวกับที่เพิ่ม shipment
      ]
    );

    // ส่งคืน response เมื่อการเพิ่มข้อมูลสำเร็จ
    res.status(200).json({
      message: "เพิ่มข้อมูล shipment สำเร็จ",
      shipmentId: shipmentId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการเพิ่มข้อมูล" });
  }
});

//ใช้หน้า shipment-list
router.get("/shipment-list/:uid", async (req, res) => {
  const uid = req.params.uid;

  try {
    // ดึงข้อมูลผู้ส่ง
    const [senderResults] = await db.query(
      "SELECT * FROM shipment WHERE sender_uid = ?",
      [uid]
    );

    // ดึงข้อมูลผู้รับ
    const [receiverResults] = await db.query(
      "SELECT * FROM shipment WHERE receiver_uid = ?",
      [uid]
    );

    // ตรวจสอบว่ามีข้อมูลผู้ส่งหรือไม่
    const senderData = senderResults.length > 0 ? senderResults : null;
    const receiverData = receiverResults.length > 0 ? receiverResults : null;

    return res.status(200).json({
      status: true,
      message: "ข้อมูลถูกดึงสำเร็จ",
      data: {
        sender: senderData,
        receiver: receiverData,
      },
    });
  } catch (err) {
    console.error("Error fetching shipment data:", err);
    return res.status(500).json({
      status: false,
      message: "เกิดข้อผิดพลาดในการดึงข้อมูล",
    });
  }
});

router.post("/shipment-detail", async (req, res) => {
  const { sid } = req.body; // รับ sid จาก request body

  if (!sid) {
    return res
      .status(400)
      .json({ status: "error", message: "sid is required" });
  }

  try {
    // 1. ค้นหาข้อมูล shipment ตาม sid
    const [shipment] = await db.execute(
      "SELECT * FROM shipment WHERE sid = ?",
      [sid]
    );

    if (shipment.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Shipment not found" });
    }

    // ดึง sender_uid, receiver_uid และ pickup_aid, delivery_aid จากข้อมูล shipment
    const { sender_uid, receiver_uid, pickup_aid, delivery_aid } = shipment[0];

    // 2. ค้นหาข้อมูลผู้ส่งจาก user table
    const [sender] = await db.execute("SELECT * FROM user WHERE uid = ?", [
      sender_uid,
    ]);

    if (sender.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Sender not found" });
    }

    // 3. ค้นหาข้อมูลผู้รับจาก user table
    const [receiver] = await db.execute("SELECT * FROM user WHERE uid = ?", [
      receiver_uid,
    ]);

    if (receiver.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Receiver not found" });
    }

    // 4. ค้นหาข้อมูลที่อยู่ของผู้ส่ง (pickup_aid) จาก address table
    const [senderAddress] = await db.execute(
      "SELECT * FROM address WHERE aid = ? AND uid = ?",
      [pickup_aid, sender_uid]
    );

    if (senderAddress.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Sender address not found" });
    }

    // 5. ค้นหาข้อมูลที่อยู่ของผู้รับ (delivery_aid) จาก address table
    const [receiverAddress] = await db.execute(
      "SELECT * FROM address WHERE aid = ? AND uid = ?",
      [delivery_aid, receiver_uid]
    );

    if (receiverAddress.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Receiver address not found" });
    }

    // สร้างข้อมูล response
    const result = {
      status: "success",
      message: "Shipment details retrieved successfully",
      data: {
        sender: {
          uid: sender[0].uid,
          name: sender[0].name,
          phone: sender[0].phone,
          image: sender[0].image,
          address: {
            aid: senderAddress[0].aid,
            label: senderAddress[0].label,
            address_text: senderAddress[0].address_text,
            latitude: senderAddress[0].latitude,
            longitude: senderAddress[0].longitude,
            is_default: senderAddress[0].is_default,
          },
        },
        receiver: {
          uid: receiver[0].uid,
          name: receiver[0].name,
          phone: receiver[0].phone,
          image: receiver[0].image,
          address: {
            aid: receiverAddress[0].aid,
            label: receiverAddress[0].label,
            address_text: receiverAddress[0].address_text,
            latitude: receiverAddress[0].latitude,
            longitude: receiverAddress[0].longitude,
            is_default: receiverAddress[0].is_default,
          },
        },
      },
    };

    // ส่งข้อมูล response
    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
  }
});

router.post("/shipment-status", async (req, res) => {
  const { sid } = req.body;

  if (!sid) {
    return res.status(400).json({
      status: "error",
      message: "sid is required",
    });
  }

  try {
    // 1. ค้นหาข้อมูล shipment
    const [shipment] = await db.execute(
      "SELECT sid, rid, status, name, description, created_at, accepted_at, picked_up_at, delivered_at FROM shipment WHERE sid = ?",
      [sid]
    );

    if (shipment.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Shipment not found",
      });
    } // 2. ค้นหาข้อมูล status_log

    const [statusLog] = await db.execute(
      "SELECT lid, status, photo FROM status_log WHERE sid = ? ORDER BY created_at DESC",
      [sid]
    ); // [ --- NEW --- ] // 3. ตรวจสอบว่ามี rid หรือไม่ ถ้ามี ให้ดึงข้อมูลไรเดอร์

    const currentShipment = shipment[0];
    let riderInfo = null; // สร้างตัวแปรไว้เก็บข้อมูลไรเดอร์

    if (currentShipment.rid) {
      // สมมติว่าตารางไรเดอร์ชื่อ 'rider' และมีคอลัมน์ 'name', 'phone', 'license_plate'
      const [rider] = await db.execute(
        "SELECT name, phone, license_plate FROM rider WHERE rid = ?",
        [currentShipment.rid]
      );

      if (rider.length > 0) {
        riderInfo = rider[0];
      }
    } // [ --- END NEW --- ] // ข้อมูลที่เราจะส่งกลับ
    const result = {
      shipment: {
        sid: currentShipment.sid,
        rid: currentShipment.rid,
        status: currentShipment.status,
        name: currentShipment.name,
        description: currentShipment.description,
        created_at: currentShipment.created_at,
        accepted_at: currentShipment.accepted_at,
        picked_up_at: currentShipment.picked_up_at,
        delivered_at: currentShipment.delivered_at,
      },
      status_log: statusLog.map((log) => ({
        lid: log.lid,
        status: log.status,
        photo: log.photo,
      })),
      rider: riderInfo, // [NEW] เพิ่มข้อมูล rider เข้าไปใน data
    }; // ส่งคืนข้อมูลทั้งหมด

    res.status(200).json({
      status: "success",
      message: "ข้อมูลการจัดส่งและสถานะถูกดึงเรียบร้อย",
      data: result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      status: "error",
      message: "เกิดข้อผิดพลาดในการดึงข้อมูล",
    });
  }
});

router.get("/shipment-locations/:userId/:shipmentType", async (req, res) => {
  const { userId, shipmentType } = req.params;

  console.log(`[LOG] ได้รับคำขอสำหรับ: UserID=${userId}, Type=${shipmentType}`);

  let conn;
  try {
    conn = await db.getConnection();

    // 1. ตรวจสอบ shipmentType ที่รับเข้ามา
    let shipmentField = "";
    if (shipmentType === "sender") {
      shipmentField = "s.sender_uid";
    } else if (shipmentType === "receiver") {
      shipmentField = "s.receiver_uid";
    } else {
      console.log(`[WARN] ไม่พบ Type ที่ชื่อ: ${shipmentType}`);
      return res.status(400).json({ error: "Invalid shipment type" });
    }

    // 2. สร้าง SQL Query
    // COALESCE จะเลือกค่าแรกที่ไม่ใช่ NULL
    // - ถ้า r.latitude มีค่า (ไรเดอร์รับงานแล้ว) -> ใช้ r.latitude
    // - ถ้า r.latitude เป็น NULL (ยังไม่มีไรเดอร์) -> ใช้ a.latitude (ที่อยู่ตอนรับของ)
    const query = `
      SELECT
        s.sid,
        s.name,
        COALESCE(r.latitude, a.latitude) AS latitude,
        COALESCE(r.longitude, a.longitude) AS longitude
      FROM
        shipment AS s
      -- JOIN address เสมอ เพื่อเอาที่อยู่ pickup มาเป็นค่าสำรอง
      JOIN
        address AS a ON s.pickup_aid = a.aid
      -- LEFT JOIN rider เพราะ rid อาจจะเป็น NULL
      LEFT JOIN
        rider AS r ON s.rid = r.rid
      WHERE
        ${shipmentField} = ?
        -- กรองเฉพาะงานที่ยังไม่เสร็จ
        AND s.status != 'ไรเดอร์นำส่งสินค้าแล้ว'
    `;

    // 3. ดึงข้อมูลจากฐานข้อมูล
    const [rows] = await conn.query(query, [userId]);

    // 4. แปลงข้อมูล
    const locations = rows.map((row) => {
      return {
        sid: String(row.sid), // แปลง sid (int) เป็น string
        name: row.name,
        latitude: parseFloat(row.latitude), // แปลง decimal/string เป็น number
        longitude: parseFloat(row.longitude), // แปลง decimal/string เป็น number
      };
    });

    console.log(`[LOG] ส่งข้อมูลกลับ ${locations.length} ตำแหน่ง`);

    // 5. ส่งข้อมูล JSON กลับไปหาแอป Flutter
    res.json(locations);
  } catch (error) {
    console.error(`[ERROR] ไม่สามารถดึงข้อมูลจากฐานข้อมูลได้:`, error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (conn) conn.release();
  }
});

router.get("/profile/:uid", async (req, res) => {
  const { uid } = req.params;

  if (!uid) {
    return res.status(400).json({ status: false, message: "_uid" });
  }

  try {
    //
    //
    //  (is_default = 1)
    //  (ORDER BY a.is_default DESC, a.aid ASC LIMIT 1)
    const sqlQuery = `
      SELECT 
        u.uid, 
        u.phone, 
        u.name, 
        u.image,
        a.address_text AS address,
        a.latitude,
        a.longitude
      FROM 
        user u
      LEFT JOIN 
        address a ON u.uid = a.uid
      WHERE 
        u.uid = ?
      ORDER BY 
        a.is_default DESC, a.aid ASC
      LIMIT 1;
    `;

    //
    // db.query()
    const [rows] = await db.query(sqlQuery, [uid]);

    if (rows.length === 0) {
      return res.status(404).json({ status: false, message: "User not found" });
    }

    //
    const userProfile = rows[0];

    //
    //
    const dataToSend = {
      uid: userProfile.uid,
      name: userProfile.name,
      phone: userProfile.phone,
      image: userProfile.image,
      address: userProfile.address ?? "", //
      latitude: userProfile.latitude,
      longitude: userProfile.longitude,
    };

    //
    res.json({ status: true, data: dataToSend });
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ status: false, message: "Server error" });
  }
});

/**
 * @route   PUT /user/profile/:uid
 * @desc
 * @access  Private
 */
router.put("/profile/:uid", async (req, res) => {
  const { uid } = req.params;
  const {
    name,
    phone,
    image,
    address,
    latitude,
    longitude,
    password, //
  } = req.body;

  // TODO:
  if (!name || !phone || !address) {
    return res
      .status(400)
      .json({ status: false, message: "Missing required fields" });
  }

  try {
    // --- 1.  `user` ---
    let userUpdateQuery;
    let userParams;

    if (password && password.length > 0) {
      //
      // const hashedPassword = await bcrypt.hash(password, 10);
      //
      const hashedPassword = `hashed_${password}`; //

      userUpdateQuery = `
        UPDATE user 
        SET name = ?, phone = ?, image = ?, password = ?
        WHERE uid = ?;
      `;
      userParams = [name, phone, image, hashedPassword, uid];
    } else {
      //
      userUpdateQuery = `
        UPDATE user 
        SET name = ?, phone = ?, image = ?
        WHERE uid = ?;
      `;
      userParams = [name, phone, image, uid];
    }

    await db.query(userUpdateQuery, userParams);

    // --- 2.  `address` ( ) ---
    //
    //
    const addressUpdateQuery = `
      UPDATE address
      SET address_text = ?, latitude = ?, longitude = ?
      WHERE uid = ? AND is_default = 1; 
    `;

    //
    //
    const [updateResult] = await db.query(addressUpdateQuery, [
      address,
      latitude,
      longitude,
      uid,
    ]);

    //
    if (updateResult.affectedRows === 0) {
      //
      const addressInsertQuery = `
        INSERT INTO address (uid, label, address_text, latitude, longitude, is_default)
        VALUES (?, 'ที่อยู่หลัก', ?, ?, ?, 1);
      `;
      await db.query(addressInsertQuery, [uid, address, latitude, longitude]);
    }

    res.json({ status: true, message: "Profile updated successfully" });
  } catch (err) {
    console.error("Error updating user profile:", err);
    res.status(500).json({ status: false, message: "Server error" });
  }
});

router.get("/addresses/user/:uid", async (req, res) => {
  const { uid } = req.params;

  if (!uid) {
    return res
      .status(400)
      .json({ status: false, message: "User ID is required" });
  }

  try {
    const [addresses] = await db.query(
      "SELECT * FROM address WHERE uid = ? ORDER BY is_default DESC, aid ASC",
      [uid]
    );

    res.json({ status: true, data: addresses });
  } catch (error) {
    console.error("Error fetching addresses:", error);
    res.status(500).json({ status: false, message: "Internal server error" });
  }
});

// --- (ที่หน้า UserAddressFormPage ใช้) ---

// POST /addresses -
router.post("/addresses", async (req, res) => {
  const { uid, label, address_text, latitude, longitude, is_default } =
    req.body;

  //
  if (is_default === true || is_default === 1) {
    try {
      //
      await db.query("UPDATE address SET is_default = 0 WHERE uid = ?", [uid]);
    } catch (error) {
      console.error("Error clearing old default address:", error);
      return res
        .status(500)
        .json({ status: false, message: "Failed to update address defaults" });
    }
  }

  try {
    const [result] = await db.query(
      "INSERT INTO address (uid, label, address_text, latitude, longitude, is_default) VALUES (?, ?, ?, ?, ?, ?)",
      [uid, label, address_text, latitude, longitude, is_default ? 1 : 0]
    );

    res
      .status(201)
      .json({
        status: true,
        message: "Address added successfully",
        insertedId: result.insertId,
      });
  } catch (error) {
    console.error("Error adding address:", error);
    res.status(500).json({ status: false, message: "Failed to add address" });
  }
});

// PUT /addresses/:aid -
router.put("/addresses/:aid", async (req, res) => {
  const { aid } = req.params;
  const { uid, label, address_text, latitude, longitude, is_default } =
    req.body;

  if (is_default === true || is_default === 1) {
    try {
      //
      await db.query("UPDATE address SET is_default = 0 WHERE uid = ?", [uid]);
    } catch (error) {
      console.error("Error clearing old default address:", error);
      return res
        .status(500)
        .json({ status: false, message: "Failed to update address defaults" });
    }
  }

  try {
    const [result] = await db.query(
      "UPDATE address SET label = ?, address_text = ?, latitude = ?, longitude = ?, is_default = ? WHERE aid = ? AND uid = ?",
      [label, address_text, latitude, longitude, is_default ? 1 : 0, aid, uid]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ status: false, message: "Address not found or user mismatch" });
    }

    res.json({ status: true, message: "Address updated successfully" });
  } catch (error) {
    console.error("Error updating address:", error);
    res
      .status(500)
      .json({ status: false, message: "Failed to update address" });
  }
});

// DELETE /addresses/:aid -
router.delete("/addresses/:aid", async (req, res) => {
  const { aid } = req.params;
  //
  // const { uid } = req.body; //

  try {
    const [result] = await db.query(
      "DELETE FROM address WHERE aid = ?", //
      [aid]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ status: false, message: "Address not found" });
    }

    res.json({ status: true, message: "Address deleted successfully" });
  } catch (error) {
    console.error("Error deleting address:", error);
    res
      .status(500)
      .json({ status: false, message: "Failed to delete address" });
  }
});

module.exports = router;
