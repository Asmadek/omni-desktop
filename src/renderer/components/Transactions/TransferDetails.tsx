/* eslint-disable promise/always-return */
import React, { ReactNode, useCallback, useEffect, useState } from 'react';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import { useHistory, useParams } from 'react-router';
import { format } from 'date-fns';
import { useLiveQuery } from 'dexie-react-hooks';
import { BN } from '@polkadot/util';
import Button from '../../ui/Button';
import {
  currentTransactionState,
  signByState,
} from '../../store/currentTransaction';
import Address from '../../ui/Address';
import { Routes } from '../../../common/constants';
import { db } from '../../db/db';
import {
  Chain,
  MultisigWallet,
  Transaction,
  TransactionStatus,
  TransactionType,
  Wallet,
} from '../../db/types';
import {
  formatAddress,
  getAddressFromWallet,
  toPublicKey,
} from '../../utils/account';
import {
  formatBalance,
  formatBalanceFromAmount,
  getAssetById,
} from '../../utils/assets';
import LinkButton from '../../ui/LinkButton';
import copy from '../../../../assets/copy.svg';
import Select, { OptionType } from '../../ui/Select';
import InputText from '../../ui/Input';
import { Connection, connectionState } from '../../store/connections';
import Signatories from './Signatories';
import Chat from './Chat';
import {
  decodeCallData,
  getApprovals,
  getTxExtrinsic,
} from '../../utils/transactions';
import Shimmer from '../../ui/Shimmer';
import { copyToClipboard } from '../../utils/strings';

const TransferDetails: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();

  const [, setSignBy] = useRecoilState(signByState);
  const networks = useRecoilValue(connectionState);
  const setCurrentTransaction = useSetRecoilState(currentTransactionState);

  const [transaction, setTransaction] = useState<Transaction>();
  const [network, setNetwork] = useState<Chain>();
  const [commission, setCommission] = useState<string>('');
  const [callData, setCallData] = useState<string>();
  const [availableWallets, setAvailableWallets] = useState<OptionType[]>([]);
  const [connection, setConnection] = useState<Connection>();

  const wallets = useLiveQuery(() => db.wallets.toArray());
  const transactions = useLiveQuery(() => db.transactions.toArray());

  const isTransfer = transaction?.type === TransactionType.TRANSFER;
  const isMultisigTransfer =
    transaction?.type === TransactionType.MULTISIG_TRANSFER;

  const isCreated = transaction?.status === TransactionStatus.CREATED;
  const isConfirmed = transaction?.status === TransactionStatus.CONFIRMED;
  const isSelectWalletAvailable =
    isMultisigTransfer &&
    transaction.data.callData &&
    availableWallets.length > 0 &&
    !isConfirmed;

  const isSignable =
    (isTransfer ||
      (isMultisigTransfer &&
        transaction.data.callData &&
        availableWallets.length > 0)) &&
    !isConfirmed;

  useEffect(() => {
    if (transaction && Object.values(networks).length) {
      const currentConnection = Object.values(networks).find(
        (n) => n.network.chainId === transaction.chainId,
      );

      if (currentConnection) {
        setConnection(currentConnection);
      }
    }
  }, [transaction, networks]);

  useEffect(() => {
    if (!network || !isMultisigTransfer) return;

    const walletsToSign = wallets?.reduce((acc, w) => {
      const address = getAddressFromWallet(w, network);

      const contacts = (
        transaction?.wallet as MultisigWallet
      ).originContacts?.map((c) => getAddressFromWallet(c, network));

      const approval = transaction?.data?.approvals[toPublicKey(address)];

      if (
        address &&
        !(approval?.fromBlockChain || approval?.fromMatrix) &&
        contacts?.includes(address)
      ) {
        acc.push(w as Wallet);
      }

      return acc;
    }, [] as Wallet[]);

    if (walletsToSign) {
      setSignBy(walletsToSign[0]);
      setAvailableWallets(
        walletsToSign.map((w) => ({
          value: w.mainAccounts[0].publicKey,
          label: w.name,
        })),
      );
    }
  }, [
    wallets,
    transaction?.data.approvals,
    transaction?.wallet,
    isMultisigTransfer,
    network,
    setSignBy,
  ]);

  const setupTransaction = useCallback(() => {
    if (!id) return;

    db.transactions
      .get(Number(id))
      .then((tx) => {
        if (tx) {
          setTransaction(tx);
        }
      })
      .catch((e) => console.warn(e));
  }, [id]);

  useEffect(() => {
    if (!transactions) return;

    const tx = transactions.find((t) => t.id === Number(id));

    if (!tx) return;

    setTransaction(tx);
  }, [transactions, id]);

  useEffect(() => {
    if (!transaction?.chainId) return;

    db.chains
      .get({ chainId: transaction.chainId })
      .then((chain) => {
        if (chain) {
          setNetwork(chain);
        }
      })
      .catch(console.warn);
  }, [transaction?.chainId]);

  const currentAsset = getAssetById(
    network?.assets || [],
    transaction?.data.assetId,
  );

  const tokenSymbol = currentAsset?.symbol || '';

  const showQR = () => {
    setCurrentTransaction(transaction);
    history.push(Routes.SHOW_CODE);
  };

  const removeTransaction = () => {
    if (!transaction?.id) return;

    db.transactions.delete(transaction.id);
    history.push(Routes.BASKET);
  };

  const formatRecipientAddress = (address: string) =>
    network ? formatAddress(address, network.addressPrefix) : address;

  const selectSignWallet = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSignBy(
      wallets?.find(
        (w) => w.mainAccounts[0].publicKey === e.target.value,
      ) as Wallet,
    );
  };

  const updateCallData = useCallback(() => {
    if (!transaction || !callData || !connection) return;

    const decodedData = decodeCallData(
      connection.api,
      connection.network,
      callData,
    );

    db.transactions.put({
      ...transaction,
      data: {
        ...transaction.data,
        callData,
        ...decodedData,
      },
    });

    setupTransaction();
    setCallData('');
  }, [transaction, callData, connection, setupTransaction]);

  // Check this case
  useEffect(() => {
    if (transaction?.data.callData && !transaction?.data.amount) {
      setCallData(transaction.data.callData);
      updateCallData();
    }
  }, [transaction, updateCallData]);

  useEffect(() => {
    if (!connection || !network || !transaction || !currentAsset) return;

    getTxExtrinsic(
      connection,
      currentAsset,
      transaction.address,
      transaction.data.amount,
    )
      .paymentInfo(transaction.address)
      .then(({ partialFee }) => {
        const formattedValue = formatBalance(
          partialFee.toString(),
          network.assets[0].precision,
        );
        setCommission(`${formattedValue} ${network.assets[0].symbol}`);
      })
      .catch((error) => {
        console.warn(error);
        setCommission('0');
      });
  }, [connection, currentAsset, network, transaction]);

  const depositValue = (): string | ReactNode => {
    if (!connection || !network || !transaction) {
      return <Shimmer width="80px" height="20px" />;
    }

    const { depositFactor, depositBase } = connection.api.consts.multisig;
    const balance = depositBase.add(
      depositFactor.mul(
        new BN((transaction.wallet as MultisigWallet).threshold),
      ),
    );
    const deposit = formatBalance(balance.toString(), currentAsset?.precision);
    return `${deposit} ${network.assets[0].symbol}`;
  };

  return (
    <>
      <div className="flex justify-center items-center mb-8">
        <LinkButton className="ml-2 absolute left-0" to={Routes.BASKET}>
          Back
        </LinkButton>
        <h2 className="h-16 p-4 font-light text-lg">Operation details</h2>
      </div>

      <div className="flex justify-center gap-6">
        <div className="mb-10 w-[350px] bg-gray-100 px-4 py-3 rounded-2xl">
          <div className="flex justify-between items-center  mb-6">
            <h1 className="text-2xl font-normal">Preview</h1>
            <span className="text-gray-500 text-sm">
              {transaction &&
                format(transaction.createdAt, 'HH:mm:ss dd MMM, yyyy')}
            </span>
          </div>

          <div className="max-h-[450px] overflow-y-auto mb-6">
            <div className="text-sm text-gray-500 mb-2">Selected account</div>
            <div>{transaction?.wallet.name}</div>
            <div>
              {network && transaction && (
                <div>
                  <Address address={transaction.address} />
                </div>
              )}
            </div>
          </div>
          <div className="text-sm text-gray-500">Operations details:</div>

          {isTransfer && (
            <div className="inline">
              Transfer{' '}
              {formatBalanceFromAmount(
                transaction.data.amount,
                currentAsset?.precision,
              )}{' '}
              {tokenSymbol} to{' '}
              <Address
                address={formatRecipientAddress(transaction.data.address)}
              />
            </div>
          )}
          {isMultisigTransfer && (
            <>
              <div className="flex">
                {transaction.data.amount && (
                  <>
                    Transfer{' '}
                    {formatBalanceFromAmount(
                      transaction.data.amount,
                      currentAsset?.precision,
                    )}{' '}
                    {tokenSymbol} to
                    <Address
                      className="ml-1"
                      address={formatRecipientAddress(transaction.data.address)}
                    />
                  </>
                )}
              </div>
              <div className="flex">
                {transaction.data.deposit && currentAsset?.precision && (
                  <>
                    Deposit:{' '}
                    {formatBalance(
                      transaction.data.deposit,
                      currentAsset.precision,
                    )}{' '}
                    {tokenSymbol}
                  </>
                )}
              </div>
              {!!transaction.data.callHash && (
                <div className="text-xs text-gray-500 mt-3">
                  <div className="flex justify-between items-center">
                    <div className="font-bold">Call hash:</div>
                    <button
                      onClick={() => copyToClipboard(transaction.data.callHash)}
                    >
                      <img src={copy} alt="copy" />
                    </button>
                  </div>
                  <div className="break-words">{transaction.data.callHash}</div>
                </div>
              )}
              {!!transaction.data.callData && (
                <div className="text-xs text-gray-500 mt-3">
                  <div className="flex justify-between items-center">
                    <div className="font-bold">Call data:</div>
                    <button
                      onClick={() => copyToClipboard(transaction.data.callData)}
                    >
                      <img src={copy} alt="copy" />
                    </button>
                  </div>
                  <div className="break-words">{transaction.data.callData}</div>
                </div>
              )}
              {transaction?.status !== TransactionStatus.CONFIRMED && (
                <div className="flex justify-between mt-2 pt-2 border-t">
                  <div className="text-gray-500 text-sm">Commission</div>
                  <div className="text-gray-500 text-sm">
                    {commission || <Shimmer width="80px" height="20px" />}
                  </div>
                </div>
              )}
              {transaction && getApprovals(transaction).length === 0 && (
                <>
                  <div className="flex justify-between mt-1">
                    <div className="text-gray-500 text-sm">Deposit</div>
                    <div className="text-gray-500 text-sm">
                      {depositValue()}
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 italic mt-2">
                    The deposit stays locked until the transaction is executed
                    or cancelled
                  </div>
                </>
              )}
              {isMultisigTransfer && !transaction.data.callData && (
                <div className="flex mt-3">
                  <InputText
                    className="mr-3"
                    label="Call data"
                    onChange={(e) => setCallData(e.target.value)}
                  />
                  <Button onClick={updateCallData}>Save</Button>
                </div>
              )}
            </>
          )}
        </div>
        {isMultisigTransfer && (
          <>
            <Signatories network={network} transaction={transaction} />
            <Chat network={network} transaction={transaction} />
          </>
        )}
      </div>
      {isSelectWalletAvailable && (
        <div className="mx-auto mb-2 w-[350px]">
          <Select
            label="Select wallet to sign with"
            options={availableWallets}
            onChange={selectSignWallet}
          />
        </div>
      )}
      {isSignable && (
        <div className="mx-auto mb-2 w-[350px]">
          <Button className="w-full" size="lg" onClick={showQR}>
            Send for signing
          </Button>
        </div>
      )}
      {isCreated && (
        <div className="mx-auto w-[350px]">
          <Button className="w-full" size="lg" onClick={removeTransaction}>
            Remove
          </Button>
        </div>
      )}
    </>
  );
};

export default TransferDetails;
