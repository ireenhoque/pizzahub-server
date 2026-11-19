import { Router, type Request, type RequestHandler } from 'express';
import { ObjectId } from 'mongodb';

import { requireCustomer, requireVendor } from '../../auth/require-auth.js';
import { ApiError } from '../../error/ApiError.js';
import { validate } from '../../middlewares/validate.js';
import {
  createOrderSchema,
  orderListQuerySchema,
  updateOrderStatusSchema,
  type OrderListQuery,
} from './order.validation.js';
import { orderService } from './order.service.js';

/**
 * Express types route params loosely (`string | string[] | undefined`).
 * Orders are addressed by a single MongoDB ObjectId path segment; anything
 * else fails fast with 400 instead of surfacing a BSON error as a 500.
 */
function getOrderParam(req: Request): string {
  const { id } = req.params;
  if (typeof id !== 'string' || !ObjectId.isValid(id)) {
    throw new ApiError(400, 'Invalid order id');
  }
  return id;
}

export function createOrderRouter(requireAuth: RequestHandler): Router {
  const router = Router();

  // Customer creates an order (role gate reads DB-verified roles from requireAuth)
  router.post('/', requireAuth, requireCustomer, validate({ body: createOrderSchema }), (async (
    req,
    res,
    next,
  ) => {
    try {
      const auth = req.auth!; // set by requireAuth
      const order = await orderService.createOrder(auth, req.body);
      res.status(201).json({ success: true, message: 'Order created', data: { order } });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler);

  // Customer list own orders
  router.get('/my', requireAuth, validate({ query: orderListQuerySchema }), (async (
    req,
    res,
    next,
  ) => {
    try {
      const auth = req.auth!;
      const pagination = req.validatedQuery as OrderListQuery;
      const result = await orderService.listCustomerOrders(auth.userId, pagination);
      res.status(200).json({ success: true, message: 'Customer orders', data: result });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler);

  // Vendor list orders for their items
  router.get(
    '/vendor',
    requireAuth,
    requireVendor,
    validate({ query: orderListQuerySchema }),
    (async (req, res, next) => {
      try {
        const auth = req.auth!;
        const pagination = req.validatedQuery as OrderListQuery;
        const result = await orderService.listVendorOrders(auth.userId, pagination);
        res.status(200).json({ success: true, message: 'Vendor orders', data: result });
      } catch (error) {
        next(error);
      }
    }) as RequestHandler,
  );

  // Get individual order — authentication REQUIRED: orders expose customer PII
  // (name, email, phone, address) and per-vendor pricing, so anonymous callers
  // are rejected with 401 before ownership is evaluated.
  router.get('/:id', requireAuth, async (req, res, next) => {
    try {
      const orderId = getOrderParam(req);
      const order = await orderService.getOrderById(orderId);
      // Ownership: the customer who placed it, the vendor fulfilling it, or an admin.
      const viewer = req.auth!;
      const isAdmin = viewer.roles.includes('admin');
      const isParticipant = order.customerId === viewer.userId || order.vendorId === viewer.userId;
      if (!isAdmin && !isParticipant) {
        throw new ApiError(403, 'Not authorized to view this order');
      }
      res.status(200).json({ success: true, message: 'Order retrieved', data: { order } });
    } catch (error) {
      next(error);
    }
  });

  // Vendor or admin updates order status (transition validity enforced in the service)
  router.patch(
    '/:id/status',
    requireAuth,
    validate({ body: updateOrderStatusSchema }),
    async (req, res, next) => {
      try {
        const orderId = getOrderParam(req);
        const auth = req.auth!;
        const { status } = updateOrderStatusSchema.parse(req.body);
        // Only admin or vendor of the order can change status
        const order = await orderService.getOrderById(orderId);
        const isAdmin = auth.roles.includes('admin');
        const isVendor = auth.roles.includes('vendor') && order.vendorId === auth.userId;
        if (!isAdmin && !isVendor) {
          throw new ApiError(403, 'Not authorized to change order status');
        }
        const updated = await orderService.updateOrderStatus(orderId, status);
        res
          .status(200)
          .json({ success: true, message: 'Order status updated', data: { order: updated } });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
