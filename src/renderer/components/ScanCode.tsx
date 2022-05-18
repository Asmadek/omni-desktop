import React from 'react';
import { useRecoilValue } from 'recoil';
import { useHistory } from 'react-router-dom';
import { QrScanSignature } from '@polkadot/react-qr';
import { GenericExtrinsic } from '@polkadot/types';
import {
  getRegistry,
  GetRegistryOpts,
  createMetadata,
  OptionsWithMeta,
  UnsignedTransaction,
} from '@substrate/txwrapper-polkadot';
import { connectionState } from '../store/api';
import {
  currentTransactionState,
  currentUnsignedState,
} from '../store/currentTransaction';
import { HexString } from '../../common/types';
import LinkButton from '../ui/LinkButton';
import { Routes } from '../../common/constants';
import { db, TransactionStatus } from '../db/db';

// TODO: Move this function to utils
function createSignedTx(
  unsigned: UnsignedTransaction,
  signature: HexString,
  options: OptionsWithMeta,
): GenericExtrinsic {
  const {
    metadataRpc,
    registry,
    asCallsOnlyArg,
    signedExtensions,
    userExtensions,
  } = options;
  const metadata = createMetadata(registry, metadataRpc, asCallsOnlyArg);

  registry.setMetadata(metadata, signedExtensions, userExtensions);

  const extrinsic = registry.createType(
    'Extrinsic',
    { method: unsigned.method },
    { version: unsigned.version },
  );

  extrinsic.addSignature(unsigned.address, signature, unsigned);

  return extrinsic;
}

const ScanCode: React.FC = () => {
  const networks = useRecoilValue(connectionState);
  const history = useHistory();

  const transaction = useRecoilValue(currentTransactionState);
  const unsigned = useRecoilValue(currentUnsignedState);

  // TODO: Refactor sign and send transaction flow
  const onGetSignature = async (payload: any) => {
    const signature = payload.signature || '';
    if (transaction && unsigned && Object.values(networks).length) {
      const network = Object.values(networks).find(
        (n) => n.network.chainId === transaction.chainId,
      );

      if (network && network.api) {
        const metadataRpc = await network.api.rpc.state.getMetadata();
        const { specVersion, specName } =
          await network.api.rpc.state.getRuntimeVersion();

        const registry = getRegistry({
          chainName: network?.network.name || '',
          specName: specName.toString() as GetRegistryOpts['specName'],
          specVersion: specVersion.toNumber(),
          metadataRpc: metadataRpc.toHex(),
        });

        const tx = createSignedTx(unsigned, signature, {
          metadataRpc: metadataRpc.toHex(),
          registry,
        });

        const actualTxHash = await network.api.rpc.author.submitExtrinsic(tx);

        if (actualTxHash && transaction.id) {
          db.transactions.update(transaction.id, {
            ...transaction,
            status: TransactionStatus.CONFIRMED,
          });

          history.push(Routes.BASKET);
        }
      }
    }
  };

  return (
    <div className="h-screen flex flex-col">
      <div className="flex justify-center items-center">
        <LinkButton className="ml-2 absolute left-0" to={Routes.SHOW_CODE}>
          Back
        </LinkButton>
        <h2 className="h-16 p-4 font-light text-lg">
          Upload signed operations via Parity Signer
        </h2>
      </div>

      <div className="flex flex-1 flex-col justify-center items-center">
        <div className="font-normal text-base">
          Scan QR code from Parity Signer with Omni
        </div>
        {transaction && (
          <div className="w-80 h-80 m-4">
            <QrScanSignature onScan={onGetSignature} />
          </div>
        )}
      </div>
    </div>
  );
};

export default ScanCode;
