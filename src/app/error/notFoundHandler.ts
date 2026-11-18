import type { Request, Response } from 'express';

export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    message: `API not found: ${req.method} ${req.originalUrl}`,
  });
};
