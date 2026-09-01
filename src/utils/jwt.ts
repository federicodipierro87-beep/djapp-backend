import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env';

export interface JWTPayload {
  djId: string;
  email: string;
  isAdmin?: boolean;
  // Set by jsonwebtoken when signing, so they are absent from what is passed to
  // generateToken and present in what comes back from verifyToken. iat is what
  // tells a session apart from one opened before the password last changed.
  iat?: number;
  exp?: number;
}

export const generateToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

export const verifyToken = (token: string): JWTPayload => {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
};