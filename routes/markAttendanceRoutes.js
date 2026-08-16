// Updated routes/markattendance.js
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Registration = require("../models/Registration");
const Conference = require("../models/Conference");
const {
  isRegistrationPaymentCompleted,
} = require("../utils/conferenceOrganizerAccess");
const {
  findRegistrationForQrCheckIn,
  getRegistrantDisplayNameFromForm,
} = require("../utils/attendanceQr");

async function findRegistrationByEmail(conferenceId, email) {
  const trimmed = (email || "").trim();
  if (!trimmed) return null;

  const conferenceFilter = mongoose.Types.ObjectId.isValid(conferenceId)
    ? {
        $or: [
          { conferenceId: new mongoose.Types.ObjectId(conferenceId) },
          { conferenceId: String(conferenceId) },
        ],
      }
    : { conferenceId: String(conferenceId) };

  const escapeRegex = (value) =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return Registration.findOne({
    ...conferenceFilter,
    email: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  });
}

// ✅ Mark Attendance with Timestamp
router.post("/markAttendance/:conferenceId", async (req, res) => {
    try {
        const { email } = req.body; // signature removed
        const { conferenceId } = req.params;

        const conference = await Conference.findById(conferenceId).lean();
        if (!conference) {
            return res.status(404).json({ message: "❌ Conference not found!" });
        }

        const user = await findRegistrationByEmail(conferenceId, email);

        if (!user) {
            return res.status(404).json({ message: "❌ User not registered for this conference!" });
        }

        if (!isRegistrationPaymentCompleted(conference, user)) {
            return res.status(403).json({ message: "❌ Registration not completed for this participant." });
        }

        await Registration.updateOne(
            { _id: user._id },
            { 
                attended: true, 
                attendedAt: new Date()
            }
        );

        return res.json({ message: "✅ Attendance marked successfully!" });

    } catch (error) {
        console.error("Error marking attendance:", error);
        res.status(500).json({ message: "❌ Server Error" });
    }
});

// ✅ Unmark Attendance
router.post("/unmarkAttendance/:conferenceId", async (req, res) => {
    try {
        const { email } = req.body;
        const { conferenceId } = req.params;

        const user = await findRegistrationByEmail(conferenceId, email);

        if (!user) {
            return res.status(404).json({ message: "❌ User not registered for this conference!" });
        }

        await Registration.updateOne(
            { _id: user._id },
            { 
                attended: false, 
                attendedAt: null
            }
        );

        return res.json({ message: "✅ Attendance unmarked successfully!" });

    } catch (error) {
        console.error("Error unmarking attendance:", error);
        res.status(500).json({ message: "❌ Server Error" });
    }
});

// ✅ Mark Attendance by QR Code
router.post("/markAttendanceByQR/:conferenceId", async (req, res) => {
    try {
        const { qrData } = req.body;
        const { conferenceId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(conferenceId)) {
            return res.status(400).json({ message: "❌ Invalid conference ID format!" });
        }

        const conference = await Conference.findById(conferenceId).lean();
        if (!conference) {
            return res.status(404).json({ message: "❌ Conference not found!" });
        }

        if (!qrData) {
            return res.status(400).json({ message: "❌ QR code data is required!" });
        }

        let parsedData;
        try {
            parsedData = JSON.parse(qrData);
        } catch (parseError) {
            return res.status(400).json({ message: "❌ Invalid QR code format!" });
        }

        const registration = await findRegistrationForQrCheckIn(conferenceId, parsedData);

        if (!registration) {
            const hasEmail = !!(parsedData?.email || parsedData?.registrationId);
            return res.status(404).json({
                message: hasEmail
                    ? "❌ Registration not found for this QR code. Re-send the attendance QR email and try again."
                    : "❌ Email not found in QR code!",
            });
        }

        if (!isRegistrationPaymentCompleted(conference, registration)) {
            return res.status(403).json({ message: "❌ Registration not completed for this participant." });
        }

        if (registration.attended) {
            return res.status(409).json({ message: "⚠️ Attendance already marked for this participant!" });
        }

        const attendedAt = new Date();
        await Registration.updateOne(
            { _id: registration._id },
            { 
                attended: true, 
                attendedAt
            }
        );

        const participantName = getRegistrantDisplayNameFromForm(
            registration.formData,
            registration.email
        );

        return res.json({ 
            message: "✅ Attendance marked successfully via QR code!", 
            participant: {
                email: registration.email,
                name: participantName,
                attendedAt
            }
        });

    } catch (error) {
        console.error("❌ Error marking attendance by QR:", error);
        res.status(500).json({ 
            message: "❌ Server Error",
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
