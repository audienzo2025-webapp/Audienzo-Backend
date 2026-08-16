# Audienzo Backend API

This is the backend API for the Audienzo conference management application, designed to be deployed on Render.

## Features

- Express.js REST API
- MongoDB with Mongoose
- User authentication with sessions
- Google OAuth integration
- File uploads with Cloudinary
- Email notifications
- QR code generation
- Payment processing with Razorpay

## Deployment on Render

### Prerequisites

1. Create a Render account
2. Connect your GitHub repository
3. Set up MongoDB Atlas database
4. Configure environment variables

### Environment Variables

Set these environment variables in your Render dashboard:

```bash
NODE_ENV=production
PORT=10000
BACKEND_URL=https://your-backend-name.onrender.com
FRONTEND_URL=https://your-frontend-name.vercel.app
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/audienzo
SESSION_SECRET=your-super-secret-session-key
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

### Deployment Steps

1. **Create New Web Service**:
   - Connect your GitHub repository
   - Set build command: `npm install`
   - Set start command: `npm start`
   - Set environment: `Node`
   - Set region: `Oregon (US West)`

2. **Configure Environment Variables** (as listed above)

3. **Deploy** and note the Render URL

### API Endpoints

- `GET /` - Health check
- `GET /api/health` - API health check
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `GET /api/auth/google` - Google OAuth
- `GET /api/conferences` - Get conferences
- `POST /api/create-event` - Create event
- `PUT /api/conferences/:id` - Update event
- `DELETE /api/conferences/:id` - Delete event

### CORS Configuration

The backend is configured to allow requests from:
- `http://localhost:4200` (development)
- `https://audienzo-frontend.vercel.app` (production)
- Custom frontend URL from `FRONTEND_URL` environment variable

### Health Checks

Render will automatically check the health of your service using the `/api/health` endpoint.

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Start production server
npm start
```

## Project Structure

```
audienzo-backend/
├── config/          # Configuration files
├── models/          # Mongoose models
├── routes/          # API routes
├── uploads/         # File uploads (if using local storage)
├── index.js         # Main server file
├── package.json     # Dependencies and scripts
└── render.yaml      # Render deployment configuration
```



