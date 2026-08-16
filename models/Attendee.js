const mongoose = require('mongoose');

const AttendeeSchema = new mongoose.Schema({
    conferenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conference', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true }, 
    attended: { type: Boolean, default: false }  
}, { timestamps: true });

module.exports = mongoose.model('Attendee', AttendeeSchema);
