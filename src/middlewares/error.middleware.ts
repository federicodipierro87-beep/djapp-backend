import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export const errorMiddleware = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error('Error:', error);

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.errors
    });
  }

  if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
    return res.status(400).json({ error: 'Email already exists' });
  }

  if (error.code === 'P2002' && error.meta?.target?.includes('eventCode')) {
    return res.status(400).json({ error: 'Event code already exists' });
  }

  if (error.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }

  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal server error';

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
};