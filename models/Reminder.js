const mongoose = require("mongoose");

const ReminderSchema = new mongoose.Schema({
    conferenceId: { type: mongoose.Schema.Types.ObjectId, ref: "Conference", required: true },
    scheduledTime: { type: Date, required: true },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    htmlMessage: { type: String, default: '' },
    emailTemplate: { type: String, default: 'announcement' },
    recipients: [{ type: String }],
    status: { type: String, enum: ["pending", "scheduled", "sent"], default: "pending" }
});

module.exports = mongoose.model("Reminder", ReminderSchema);
