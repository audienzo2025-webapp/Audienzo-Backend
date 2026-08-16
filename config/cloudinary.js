require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const path = require('path');

// 🔹 Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Image Upload Storage
const imageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'conference_uploads',
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
        public_id: (req, file) => `${Date.now()}-${file.originalname.split('.')[0]}`,
    },
});

const imageFileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only image files (PNG, JPG, JPEG, WEBP, GIF) are allowed!'), false);
    }
};

const uploadImage = multer({ storage: imageStorage, fileFilter: imageFileFilter });

// 🔹 Local Upload for Agenda (PDF)
const uploadLocal = multer({ dest: 'uploads/' });

module.exports = { cloudinary, uploadImage, uploadLocal };
