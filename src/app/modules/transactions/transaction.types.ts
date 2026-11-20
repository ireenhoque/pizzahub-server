import type { PaginationMeta } from '../users/user.types.js';

export type AdminTransactionContext = 'customer_order' | 'vendor_subscription';

export interface TransactionParty {
  id: string;
  name: string | null;
  email: string | null;
}

export interface AdminTransaction {
  id: string;
  context: AdminTransactionContext;
  type: 'payment' | 'refund';
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';
  amount: number;
  currency: string;
  orderId?: string;
  customer: TransactionParty;
  vendor: TransactionParty;
  stripeSessionId: string;
  stripePaymentIntentId?: string;
  stripeSubscriptionId?: string;
  stripeEventId?: string;
  paidAt?: Date;
  refundedAt?: Date;
  failureReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ListTransactionsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: 'pending' | 'paid' | 'failed' | 'refunded';
  type?: 'payment' | 'refund';
  sortBy: 'createdAt' | 'amount' | 'updatedAt';
  sortOrder: 'asc' | 'desc';
  from?: Date;
  to?: Date;
}

export interface ListTransactionsResult {
  transactions: AdminTransaction[];
  pagination: PaginationMeta;
}
