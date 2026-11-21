/** Whitelisted admin overview DTO — counts only, never raw documents. */
export interface AdminOverview {
  users: {
    total: number;
    customers: number;
    vendors: number;
    admins: number;
  };
  menuItems: {
    total: number;
    active: number;
    pending: number;
    inactive: number;
    rejected: number;
    outOfStock: number;
  };
  orders: {
    total: number;
    placed: number;
    delivered: number;
  };
  transactions: {
    count: number;
    paidCount: number;
    totalAmount: number;
    paidAmount: number;
    currency: string;
  };
}
