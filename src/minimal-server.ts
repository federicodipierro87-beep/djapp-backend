import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Basic middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    env: {
      PORT: process.env.PORT,
      DATABASE_URL: process.env.DATABASE_URL ? 'CONFIGURED' : 'MISSING',
      JWT_SECRET: process.env.JWT_SECRET ? 'CONFIGURED' : 'MISSING',
      FRONTEND_URL: process.env.FRONTEND_URL || 'NOT_SET'
    }
  });
});

// Temporary message for all other routes
app.all('*', (req, res) => {
  res.status(503).json({ 
    error: 'Server in maintenance mode', 
    message: 'Debugging database connection issues' 
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Minimal server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', (err) => {
  console.error('Server failed to start:', err);
});