import type { ObjectId } from 'mongodb';
import type { BaseDocument, UserReference } from './common.types.js';

/**
 * Order lifecycle. `cart` is the pre-payment state owned by the customer;
 * everything after `placed` is fulfillment state. A final order is archived,
 * never deleted, so history indexes can rely on `createdAt`.
 */
export const ORDER_STATUSES = [
  'cart',
  'placed',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderLineItem {
  menuItemId: ObjectId;
  /**
   * Denormalized snapshot taken at purchase time, so historical orders keep
   * making sense after vendors rename items or change prices.
   */
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface Order extends BaseDocument {
  /** Better Auth customer `_id` — reference only; customer data is NOT duplicated. */
  customerId: UserReference;

  /** Better Auth vendor `_id` — reference only; vendor data is NOT duplicated. */
  vendorId: UserReference;

  lineItems: OrderLineItem[];
  status: OrderStatus;

  subtotal: number;
  deliveryFee: number;
  totalAmount: number;
  currency: string;

  deliveryAddress: string;
  contactPhone?: string;
  notes?: string;

  placedAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
}
