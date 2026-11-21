import { normalizeRoles } from '../../auth/require-auth.js';
import {
  getMenuItemsCollection,
  getOrdersCollection,
  getTransactionsCollection,
  getUsersCollection,
} from '../../db/collections.js';
import {
  MENU_ITEM_CURRENCY,
  MENU_ITEM_STATUSES,
  type MenuItemStatus,
} from '../../types/menuItem.types.js';
import type { PaymentStatus } from '../../types/common.types.js';
import type { OrderStatus } from '../../types/order.types.js';
import type { AdminOverview } from './admin.types.js';

/**
 * Builds the admin overview from existing records only. Every value in the
 * returned DTO is a count or a number — no raw user, menu, order or payment
 * document is exposed by this endpoint.
 */
export const adminService = {
  async getOverview(): Promise<AdminOverview> {
    const users = await getUsersCollection()
      .find({}, { projection: { _id: 1, role: 1 } })
      .toArray();

    const userCounts = { customers: 0, vendors: 0, admins: 0 };
    for (const user of users) {
      // Roles can be scalar or arrays and a user may hold more than one role.
      for (const role of new Set(normalizeRoles(user))) {
        if (role === 'customer') userCounts.customers += 1;
        if (role === 'vendor') userCounts.vendors += 1;
        if (role === 'admin') userCounts.admins += 1;
      }
    }

    const menuStatusCounts = Object.fromEntries(
      MENU_ITEM_STATUSES.map((status) => [status, 0]),
    ) as Record<MenuItemStatus, number>;
    const menuGroups = await getMenuItemsCollection()
      .aggregate<{ _id?: MenuItemStatus | null; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
    for (const group of menuGroups) {
      if (group._id && group._id in menuStatusCounts) {
        menuStatusCounts[group._id] = group.count;
      }
    }

    const orderGroups = await getOrdersCollection()
      .aggregate<{ _id?: OrderStatus | null; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
    let placedOrders = 0;
    let deliveredOrders = 0;
    let totalOrders = 0;
    for (const group of orderGroups) {
      totalOrders += group.count;
      if (group._id === 'placed') placedOrders += group.count;
      if (group._id === 'delivered') deliveredOrders += group.count;
    }

    const transactionGroups = await getTransactionsCollection()
      .aggregate<{
        _id: { paymentStatus?: PaymentStatus | null; currency?: string | null };
        count: number;
        total: number;
      }>([
        {
          $group: {
            _id: { paymentStatus: '$paymentStatus', currency: '$currency' },
            count: { $sum: 1 },
            total: { $sum: '$amount' },
          },
        },
      ])
      .toArray();

    let transactionCount = 0;
    let paidCount = 0;
    let totalAmount = 0;
    let paidAmount = 0;
    const currencies = new Set<string>();
    for (const group of transactionGroups) {
      const amount = Number(group.total) || 0;
      transactionCount += group.count;
      totalAmount += amount;
      if (group._id.paymentStatus === 'paid') {
        paidCount += group.count;
        paidAmount += amount;
      }
      if (group._id.currency) {
        currencies.add(group._id.currency);
      }
    }

    const currency =
      currencies.size === 1
        ? [...currencies][0]!
        : currencies.size > 1
          ? 'MIXED'
          : MENU_ITEM_CURRENCY;

    return {
      users: {
        total: users.length,
        ...userCounts,
      },
      menuItems: {
        total: Object.values(menuStatusCounts).reduce((sum, count) => sum + count, 0),
        active: menuStatusCounts.active,
        pending: menuStatusCounts.pending,
        inactive: menuStatusCounts.inactive,
        rejected: menuStatusCounts.rejected,
        outOfStock: menuStatusCounts.out_of_stock,
      },
      orders: {
        total: totalOrders,
        placed: placedOrders,
        delivered: deliveredOrders,
      },
      transactions: {
        count: transactionCount,
        paidCount,
        totalAmount,
        paidAmount,
        currency,
      },
    };
  },
};
