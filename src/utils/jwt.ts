import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env';

export interface JWTPayload {
  djId: string;
  email: string;
  isAdmin?: boolean;
}

export const generateToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

export const verifyToken = (token: string): JWTPayload => {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
};