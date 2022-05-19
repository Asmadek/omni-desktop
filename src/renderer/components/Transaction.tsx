import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSetRecoilState } from 'recoil';
import { useHistory } from 'react-router';
import { format } from 'date-fns';
import Button from '../ui/Button';
import { currentTransactionState } from '../store/currentTransaction';
import Address from '../ui/Address';
import { Routes } from '../../common/constants';
import {
  AssetType,
  db,
  OrmlExtras,
  StatemineExtras,
  Transaction as TransactionData,
  TransactionType,
} from '../db/db';
import { formatAddress, getAddressFromWallet } from '../utils/account';

type Props = {
  transaction: TransactionData;
};

const Transaction: React.FC<Props> = ({ transaction }: Props) => {
  const setCurrentTransaction = useSetRecoilState(currentTransactionState);
  const network = useLiveQuery(() =>
    db.chains.get({ chainId: transaction.chainId }),
  );

  const history = useHistory();
  const tokenSymbol =
    network?.assets.find((a) => {
      let assetId;
      switch (a.type) {
        case AssetType.ORML:
          assetId = (a.typeExtras as OrmlExtras).currencyIdScale;
          break;
        case AssetType.STATEMINE:
          assetId = (a.typeExtras as StatemineExtras).assetId;
          break;
        default:
          assetId = a.assetId;
      }

      return assetId === transaction.data.assetId;
    })?.symbol || '';

  const showQR = () => {
    setCurrentTransaction(transaction);
    history.push(Routes.SHOW_CODE);
  };

  const formatRecipientAddress = (address: string) =>
    network ? formatAddress(address, network.addressPrefix) : address;

  return (
    <div className="bg-gray-100 p-4 m-4 rounded-lg">
      <div>
        <div className="text-gray-500 text-sm">
          {format(transaction.createdAt, 'HH:mm:ss dd MMM, yyyy')}
        </div>
        <div className="text-gray-500">Selected account</div>
        {network && (
          <div>
            <Address
              address={getAddressFromWallet(transaction.wallet, network)}
            />
          </div>
        )}
      </div>
      <div className="text-gray-500">Operations details:</div>
      {transaction.type === TransactionType.TRANSFER ||
      transaction.type === TransactionType.MULTISIG_TRANSFER ? (
        <div className="flex">
          Transfer {transaction.data.amount} {tokenSymbol} to{' '}
          <Address address={formatRecipientAddress(transaction.data.address)} />
        </div>
      ) : (
        <div>
          <div>Type: {transaction.type}</div>
          {Object.entries(transaction.data).map((type, value) => (
            <div>
              {type}: {value}
            </div>
          ))}
        </div>
      )}

      <Button onClick={showQR}>Show QR Code</Button>
    </div>
  );
};

export default Transaction;
