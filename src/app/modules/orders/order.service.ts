import { ApiError } from '../../error/ApiError.js';
import {
  getOrdersCollection,
  getMenuItemsCollection,
  findBetterAuthUserById,
} from '../../db/collections.js';
import type { Order, OrderLineItem, OrderStatus } from '../../types/order.types.js';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import { ObjectId } from 'mongodb';
import { isUserBlocked } from '../../auth/require-auth.js';
import { MENU_ITEM_CURRENCY } from '../../types/menuItem.types.js';

/**
 * Legal order status flow. `delivered` and `cancelled` are terminal —
 * resurrecting a finished order (e.g. `cancelled → preparing`) is rejected
 * with 409 instead of silently corrupting fulfillment state.
 */
const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  cart: ['placed', 'cancelled'],
  placed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

/** Helper to fetch menu item and ensure it is active & available */
async function assertMenuItemAvailable(menuItemId: string) {
  const item = await getMenuItemsCollection().findOne({ _id: new ObjectId(menuItemId) });
  if (!item) {
    throw new ApiError(404, 'Menu item not found');
  }
  if (item.status !== 'active' || !item.isAvailable) {
    throw new ApiError(400, 'Menu item is not available for ordering');
  }
  return item;
}

export const orderService = {
  /** Create a new order (customer only). */
  async createOrder(
    auth: AuthenticatedUser,
    input: {
      lineItems: { menuItemId: string; quantity: number }[];
      deliveryAddress: string;
      contactPhone?: string;
      notes?: string;
    },
  ): Promise<Order> {
    // Customers only. `auth.roles` is DB-derived (requireAuth resolves the user
    // from MongoDB on every request) — token/body/header roles are never used.
    if (!auth.roles.includes('customer')) {
      throw new ApiError(403, 'Only customers can place orders');
    }
    const customer = await findBetterAuthUserById(auth.userId);
    if (!customer) {
      throw new ApiError(404, 'User not found');
    }
    // Blocked = PizzaHub `isBlocked` OR Better Auth admin-plugin `banned`
    // (temporary bans count until `banExpires` passes).
    if (isUserBlocked(customer)) {
      throw new ApiError(403, 'User is blocked and cannot place orders');
    }

    // Validate each line item, fetch menu snapshot and collect item vendors.
    const snapshotItems: OrderLineItem[] = [];
    const vendorIds = new Set<string>();
    for (const li of input.lineItems) {
      const menuItem = await assertMenuItemAvailable(li.menuItemId);
      vendorIds.add(menuItem.vendorId);
      snapshotItems.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        unitPrice: menuItem.price,
        quantity: li.quantity,
      });
    }

    // Orders are single-vendor documents: one `vendorId` drives fulfillment,
    // the vendor order queue and the open-cart uniqueness index. Never derive
    // it from an arbitrary line item — reject mixed-vendor carts instead.
    const distinctVendorIds = [...vendorIds];
    const vendorId = distinctVendorIds[0];
    if (distinctVendorIds.length !== 1 || !vendorId) {
      throw new ApiError(400, 'All items in an order must belong to the same vendor');
    }

    // Simple duplicate active order check: same customer, same vendor, not cancelled/delivered, same menuItem.
    const existing = await getOrdersCollection().findOne({
      customerId: auth.userId,
      vendorId,
      'lineItems.menuItemId': { $in: snapshotItems.map((i) => i.menuItemId) },
      status: { $nin: ['delivered', 'cancelled'] },
    });
    if (existing) {
      throw new ApiError(400, 'You already have an active order for one of these items');
    }

    const subtotal = snapshotItems.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0);
    const deliveryFee = 0; // placeholder – could be dynamic.
    const totalAmount = subtotal + deliveryFee;

    const now = new Date();
    const orderDoc: Order = {
      _id: new ObjectId(),
      customerId: auth.userId,
      vendorId,
      lineItems: snapshotItems,
      status: 'placed',
      subtotal,
      deliveryFee,
      totalAmount,
      currency: MENU_ITEM_CURRENCY,
      deliveryAddress: input.deliveryAddress,
      contactPhone: input.contactPhone,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };

    const result = await getOrdersCollection().insertOne(orderDoc);
    orderDoc._id = result.insertedId;
    return orderDoc;
  },

  /** Retrieve orders for a given customer (paginated). */
  async listCustomerOrders(customerId: string, pagination: { page: number; limit: number }) {
    const collection = getOrdersCollection();
    const total = await collection.countDocuments({ customerId });
    const skip = (pagination.page - 1) * pagination.limit;
    const cursor = collection
      .find({ customerId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pagination.limit);
    const orders = await cursor.toArray();
    return {
      orders,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  },

  /** Retrieve a single order; authorization (ownership/admin) happens in the route. */
  async getOrderById(id: string) {
    if (!ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid order id');
    }
    const order = await getOrdersCollection().findOne({ _id: new ObjectId(id) });
    if (!order) {
      throw new ApiError(404, 'Order not found');
    }
    return order;
  },

  /** Retrieve orders for a vendor (paginated). */
  async listVendorOrders(vendorId: string, pagination: { page: number; limit: number }) {
    const collection = getOrdersCollection();
    const total = await collection.countDocuments({ vendorId });
    const skip = (pagination.page - 1) * pagination.limit;
    const cursor = collection
      .find({ vendorId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pagination.limit);
    const orders = await cursor.toArray();
    return {
      orders,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  },

  /** Update order status (vendor or admin), enforcing the legal status flow. */
  async updateOrderStatus(id: string, newStatus: OrderStatus) {
    if (!ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid order id');
    }
    const collection = getOrdersCollection();
    const order = await collection.findOne({ _id: new ObjectId(id) });
    if (!order) {
      throw new ApiError(404, 'Order not found');
    }
    // Idempotent retry: the order is already in the requested state.
    if (order.status === newStatus) {
      return order;
    }
    const allowedNext = ORDER_STATUS_TRANSITIONS[order.status];
    if (!allowedNext.includes(newStatus)) {
      throw new ApiError(
        409,
        `Invalid status transition: an order cannot move from '${order.status}' to '${newStatus}'`,
      );
    }
    await collection.updateOne(
      { _id: order._id },
      { $set: { status: newStatus, updatedAt: new Date() } },
    );
    const updated = await collection.findOne({ _id: order._id });
    if (!updated) {
      throw new ApiError(404, 'Order not found');
    }
    return updated;
  },
};
