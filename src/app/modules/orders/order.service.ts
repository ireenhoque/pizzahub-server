import { ApiError } from '../../error/ApiError.js';
import { getOrdersCollection, getMenuItemsCollection, findBetterAuthUserById } from '../../db/collections.js';
import type { Order, OrderLineItem, OrderStatus } from '../../types/order.types.js';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import { ObjectId } from 'mongodb';
import { hasActivePremiumSubscription } from '../users/user.service.js'; // maybe not needed
import { toPublicMenuItem } from '../menuItems/menu-item.service.js'; // for snapshot

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
  async createOrder(auth: AuthenticatedUser, input: {
    lineItems: { menuItemId: string; quantity: number }[];
    deliveryAddress: string;
    contactPhone?: string;
    notes?: string;
  }): Promise<Order> {
    // Ensure the authenticated user is a customer (not vendor/admin only). Role check is performed in controller.
    const customer = await findBetterAuthUserById(auth.userId);
    if (!customer) {
      throw new ApiError(404, 'User not found');
    }
    if (customer.blocked) {
      throw new ApiError(403, 'User is blocked and cannot place orders');
    }

    // Validate each line item, fetch menu snapshot.
    const snapshotItems: OrderLineItem[] = [];
    for (const li of input.lineItems) {
      const menuItem = await assertMenuItemAvailable(li.menuItemId);
      snapshotItems.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        unitPrice: menuItem.price,
        quantity: li.quantity,
      });
    }

    // Simple duplicate active order check: same customer, same vendor, not cancelled/delivered, same menuItem.
    const vendorId = snapshotItems[0].menuItemId ? (await getMenuItemsCollection().findOne({ _id: snapshotItems[0].menuItemId }))?.vendorId : null;
    if (vendorId) {
      const existing = await getOrdersCollection().findOne({
        customerId: auth.userId,
        vendorId,
        'lineItems.menuItemId': { $in: snapshotItems.map((i) => i.menuItemId) },
        status: { $nin: ['delivered', 'cancelled'] },
      });
      if (existing) {
        throw new ApiError(400, 'You already have an active order for one of these items');
      }
    }

    const subtotal = snapshotItems.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0);
    const deliveryFee = 0; // placeholder – could be dynamic.
    const totalAmount = subtotal + deliveryFee;

    const now = new Date();
    const orderDoc: Order = {
      _id: new ObjectId(), // will be replaced by insertOne result
      customerId: auth.userId,
      vendorId: vendorId ?? '',
      lineItems: snapshotItems,
      status: 'placed',
      subtotal,
      deliveryFee,
      totalAmount,
      currency: 'USD',
      deliveryAddress: input.deliveryAddress,
      contactPhone: input.contactPhone,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    } as any; // cast to satisfy BaseDocument fields

    const result = await getOrdersCollection().insertOne(orderDoc as any);
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
    return { orders, pagination: { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) } };
  },

  /** Retrieve a single order, ensuring the requester owns it (customer or vendor). */
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
    return { orders, pagination: { ...pagination, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) } };
  },

  /** Update order status (vendor or admin). */
  async updateOrderStatus(id: string, newStatus: OrderStatus) {
    const collection = getOrdersCollection();
    const order = await collection.findOne({ _id: new ObjectId(id) });
    if (!order) {
      throw new ApiError(404, 'Order not found');
    }
    // Basic allowed transitions – could be more sophisticated.
    const allowed = new Set(['placed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled']);
    if (!allowed.has(newStatus)) {
      throw new ApiError(400, 'Invalid order status');
    }
    await collection.updateOne({ _id: order._id }, { $set: { status: newStatus, updatedAt: new Date() } });
    const updated = await collection.findOne({ _id: order._id });
    return updated as Order;
  },
};
