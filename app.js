// app.js
const express = require("express");
const cors = require("cors");

// routers
const user = require("./api/user");
const together = require("./api/together");
const rider = require("./api/rider");

const app = express();

// --- Middleware พื้นฐาน ---
app.use(cors({ origin: true, credentials: true }));
app.use(express.json()); // แทน body-parser.json()
app.use(express.urlencoded({ extended: true })); // ถ้ารองรับ form-url-encoded

// --- Health check ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Mount routes ---
app.use("/user", user);
app.use("/together", together);
app.use("/rider", rider);

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ status: false, message: "Not found" });
});

// --- Error handler กลาง (กันหลุด stack) ---
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ status: false, message: "Internal server error" });
});

module.exports = app;
