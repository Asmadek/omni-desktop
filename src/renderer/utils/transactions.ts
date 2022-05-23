/* eslint-disable import/prefer-default-export */
import { ApiPromise } from '@polkadot/api';
import { U8aFixed } from '@polkadot/types';
import { PalletMultisigMultisig } from '@polkadot/types/lookup';
import { Connection } from '../store/connections';

import {
  Chain,
  db,
  Transaction,
  TransactionStatus,
  TransactionType,
  Wallet,
} from '../db/db';
import { getAddressFromWallet } from './account';

type MultisigTransaction = {
  callHash: U8aFixed;
  opt: PalletMultisigMultisig;
};

export const getPendingTransactionsFromChain = async (
  api: ApiPromise,
  address: string,
): Promise<MultisigTransaction[]> => {
  const multisigs = await api.query.multisig.multisigs.entries(address);
  return multisigs
    .filter(([, opt]) => opt.isSome)
    .reduce((result, [storage, opt]) => {
      if (opt.isNone) return result;

      const optValue = opt.unwrap();
      const [, callHash] = storage.args;

      return [
        ...result,
        {
          callHash,
          opt: optValue,
        },
      ];
    }, [] as MultisigTransaction[]);
};

export const isSameTransactions = (
  transaction: Transaction,
  multisigTransaction: MultisigTransaction,
) => {
  const isMultisigTransfer =
    transaction.type === TransactionType.MULTISIG_TRANSFER;
  const isSameDepositor =
    multisigTransaction.opt.depositor.toString() === transaction.address;
  const isSameBlockHeight =
    multisigTransaction.opt.when.height.toString() ===
    transaction.blockHeight?.toString();
  const isSameDeposit =
    multisigTransaction.opt.deposit.toString() ===
    transaction.data.deposit?.toString();
  const isSameCallHash =
    multisigTransaction.callHash.toString() ===
    transaction.data.callHash?.toString();

  return (
    isMultisigTransfer &&
    isSameDeposit &&
    isSameBlockHeight &&
    isSameDepositor &&
    isSameCallHash
  );
};

export const updateTransactionPayload = (
  transaction: Transaction,
  pendingTransaction: MultisigTransaction,
): Transaction => {
  return {
    ...transaction,
    blockHeight: pendingTransaction.opt.when.height.toNumber(),
    blockHash: pendingTransaction.opt.when.hash.toHex(),
    data: {
      ...transaction.data,
      deposit: pendingTransaction.opt.deposit.toString(),
      approvals: pendingTransaction.opt.approvals.map((a) => a.toString()),
    },
  };
};

export const createTransactionPayload = (
  pendingTransaction: MultisigTransaction,
  network: Chain,
  wallet: Wallet,
): Transaction => {
  const {
    callHash,
    opt: { depositor, when, approvals, deposit },
  } = pendingTransaction;

  return {
    address: depositor.toString(),
    createdAt: new Date(),
    type: TransactionType.MULTISIG_TRANSFER,
    blockHeight: when.height.toNumber(),
    blockHash: when.hash.toHex(),
    wallet,
    chainId: network.chainId,
    status: TransactionStatus.PENDING,
    data: {
      callHash: callHash.toHex(),
      deposit: deposit.toString(),
      approvals: approvals.map((a) => a.toString()),
    },
  };
};

export const updateTransactions = async (
  savedTransactions: Transaction[] = [],
  wallet: Wallet,
  connection: Connection,
) => {
  const pendingTransactions = await getPendingTransactionsFromChain(
    connection.api,
    getAddressFromWallet(wallet, connection.network),
  );

  pendingTransactions.forEach((p) => {
    const savedTransaction = savedTransactions.find((s) =>
      isSameTransactions(s, p),
    );

    if (savedTransaction) {
      db.transactions.put(updateTransactionPayload(savedTransaction, p));
    } else {
      db.transactions.add(
        createTransactionPayload(p, connection.network, wallet),
      );
    }
  });
};
