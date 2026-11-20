import type { RequestHandler } from 'express';
import { transactionService } from './transaction.service.js';
import type { ListTransactionsQuery } from './transaction.types.js';

export const listTransactions: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validatedQuery as ListTransactionsQuery;
    const result = await transactionService.listTransactions(query);
    res.status(200).json({ success: true, message: 'Transactions retrieved', data: result });
  } catch (error) {
    next(error);
  }
};
