import type { RequestHandler } from 'express';
import { adminService } from './admin.service.js';

export const getOverview: RequestHandler = async (_req, res, next) => {
  try {
    const overview = await adminService.getOverview();
    res.status(200).json({
      success: true,
      message: 'Admin overview retrieved',
      data: overview,
    });
  } catch (error) {
    next(error);
  }
};
