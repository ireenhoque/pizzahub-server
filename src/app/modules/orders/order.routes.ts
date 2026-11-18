import { Router, type RequestHandler } from 'express';
import { requireAuth, optionalAuth, requireAdmin, requireVendor } from '../../auth/require-auth.js';
import { validate } from '../../middlewares/validate.js';
import { createOrderSchema, orderListQuerySchema } from './order.validation.js';
import { orderService } from './order.service.js';
import type { UploadImageFn } from '../menuItems/menu-item.types.js'; // not needed but keep import style

export interface OrderRouterOptions {
  /** optional dependencies */
}

export function createOrderRouter(requireAuth: RequestHandler, options: OrderRouterOptions = {}): Router {
  const router = Router();

  // Customer creates an order
  router.post(
    '/',
    requireAuth,
    validate({ body: createOrderSchema }),
    (async (req, res, next) => {
      try {
        const auth = req.auth!; // set by requireAuth
        const order = await orderService.createOrder(auth, req.body);
        res.status(201).json({ success: true, message: 'Order created', data: { order } });
      } catch (error) {
        next(error);
      }
    }) as RequestHandler,
  );

  // Customer list own orders
  router.get(
    '/my',
    requireAuth,
    validate({ query: orderListQuerySchema }),
    (async (req, res, next) => {
      try {
        const auth = req.auth!;
        const pagination = req.validatedQuery as any;
        const result = await orderService.listCustomerOrders(auth.userId, pagination);
        res.status(200).json({ success: true, message: 'Customer orders', data: result });
      } catch (error) {
        next(error);
      }
    }) as RequestHandler,
  );

  // Vendor list orders for their items
  router.get(
    '/vendor',
    requireAuth,
    requireVendor,
    validate({ query: orderListQuerySchema }),
    (async (req, res, next) => {
      try {
        const auth = req.auth!;
        const pagination = req.validatedQuery as any;
        const result = await orderService.listVendorOrders(auth.userId, pagination);
        res.status(200).json({ success: true, message: 'Vendor orders', data: result });
      } catch (error) {
        next(error);
      }
    }) as RequestHandler,
  );

  // Get individual order – auth optional but will enforce ownership inside service
  router.get(
    '/:id',
    optionalAuth(requireAuth),
    async (req, res, next) => {
      try {
        const order = await orderService.getOrderById(req.params.id);
        // Ownership check: if viewer is customer, ensure order.customerId matches; if vendor, ensure order.vendorId matches.
        const viewer = req.auth ?? null;
        if (viewer) {
          const isCustomer = viewer.roles.includes('customer');
          const isVendor = viewer.roles.includes('vendor');
          if (isCustomer && order.customerId !== viewer.userId) {
            throw new ApiError(403, 'Not authorized to view this order');
          }
          if (isVendor && order.vendorId !== viewer.userId) {
            throw new ApiError(403, 'Not authorized to view this order');
          }
        }
        res.status(200).json({ success: true, message: 'Order retrieved', data: { order } });
      } catch (error) {
        next(error);
      }
    },
  );

  // Vendor or admin updates order status
  router.patch(
    '/:id/status',
    requireAuth,
    validate({ body: z.object({ status: z.enum(['placed','preparing','ready','out_for_delivery','delivered','cancelled']) }) }),
    async (req, res, next) => {
      try {
        const auth = req.auth!;
        const { status } = req.body as any;
        // Only admin or vendor of the order can change status
        const order = await orderService.getOrderById(req.params.id);
        const isAdmin = auth.roles.includes('admin');
        const isVendor = auth.roles.includes('vendor') && order.vendorId === auth.userId;
        if (!isAdmin && !isVendor) {
          throw new ApiError(403, 'Not authorized to change order status');
        }
        const updated = await orderService.updateOrderStatus(req.params.id, status);
        res.status(200).json({ success: true, message: 'Order status updated', data: { order: updated } });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

