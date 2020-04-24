import Web3 from 'web3';
import Contract from 'web3/eth/contract';
import { Observable, interval, from } from 'rxjs';
import { switchMap, skipWhile } from 'rxjs/operators';
import BN from 'bn.js';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { autobind } from 'core-decorators';

import { TOKEN_CONFIG } from 'env';
import bridgeAbi from 'abis/bridge.json';
import erc20Abi from 'abis/erc20.json';
import { getContractData$ } from 'utils/ethereum';
import { Direction, Status } from 'generated/bridge-graphql';

import { TransfersApi } from './TransfersApi';
import { ICreateProposalOptions } from './types';

export class EthereumApi {
  private daiContract: Contract;
  private bridgeContract: Contract;

  constructor(private web3: Web3, private transfersApi: TransfersApi) {
    this.daiContract = new this.web3.eth.Contract(erc20Abi, TOKEN_CONFIG.contracts.token);
    this.bridgeContract = new this.web3.eth.Contract(
      bridgeAbi,
      TOKEN_CONFIG.contracts.bridge,
    );
  }

  @autobind
  public async sendToSubstrate(fromAddress: string, to: string, amount: string): Promise<void> {
    await this.approveBridge(fromAddress, amount);
    await this.sendToBridge(fromAddress, to, amount);
  }

  @autobind
  public getTokenBalance$(address: string): Observable<BN> {
    const formattedAddress = address.toLowerCase();

    return getContractData$<string, BN>(this.daiContract, 'balanceOf', {
      args: [formattedAddress],
      eventsForReload: [
        ['Transfer', { filter: { _from: formattedAddress } }],
        ['Transfer', { filter: { _to: formattedAddress } }],
      ],
      convert: value => new BN(value),
    });
  }

  @autobind
  public getAccount$(): Observable<string | null> {
    return from(getEthAccount(this.web3)).pipe(
      skipWhile(account => !account),
      switchMap(() => interval(1000).pipe(switchMap(() => getEthAccount(this.web3)))),
    );
  }

  @autobind
  public async approveNewLimit(proposalId: string, fromAddress: string): Promise<void> {
    await this.daiContract.methods.approvedNewProposal(proposalId).send({ from: fromAddress }); // TODO need to test
  }

  @autobind
  public async createLimitProposal(options: ICreateProposalOptions): Promise<void> {
    const {
      fromAddress,
      MIN_HOST_TRANSACTION_VALUE,
      MAX_HOST_TRANSACTION_VALUE,
      DAY_HOST_MAX_LIMIT,
      DAY_HOST_MAX_LIMIT_FOR_ONE_ADDRESS,
      MAX_HOST_PENDING_TRANSACTION_LIMIT,
      MIN_GUEST_TRANSACTION_VALUE,
      MAX_GUEST_TRANSACTION_VALUE,
      DAY_GUEST_MAX_LIMIT,
      DAY_GUEST_MAX_LIMIT_FOR_ONE_ADDRESS,
      MAX_GUEST_PENDING_TRANSACTION_LIMIT,
    } = options;

    await this.daiContract.methods
      .createProposal(
        MIN_HOST_TRANSACTION_VALUE,
        MAX_HOST_TRANSACTION_VALUE,
        DAY_HOST_MAX_LIMIT,
        DAY_HOST_MAX_LIMIT_FOR_ONE_ADDRESS,
        MAX_HOST_PENDING_TRANSACTION_LIMIT,
        MIN_GUEST_TRANSACTION_VALUE,
        MAX_GUEST_TRANSACTION_VALUE,
        DAY_GUEST_MAX_LIMIT,
        DAY_GUEST_MAX_LIMIT_FOR_ONE_ADDRESS,
        MAX_GUEST_PENDING_TRANSACTION_LIMIT,
      )
      .send({ from: fromAddress }); // TODO need to test
  }

  private async approveBridge(fromAddress: string, amount: string): Promise<void> {
    const allowance: string = await this.daiContract.methods
      .allowance(fromAddress, TOKEN_CONFIG.contracts.bridgeTransfer)
      .call();

    if (new BN(amount).lte(new BN(allowance))) {
      return;
    }

    await this.daiContract.methods
      .approve(TOKEN_CONFIG.contracts.bridgeTransfer, amount)
      .send({ from: fromAddress });
  }

  private async sendToBridge(fromAddress: string, to: string, amount: string): Promise<void> {
    const formatedToAddress = u8aToHex(decodeAddress(to));
    const bytesAddress = this.web3.utils.hexToBytes(formatedToAddress);

    const result = await this.bridgeContract.methods
      .setTransfer(amount, bytesAddress)
      .send({ from: fromAddress });

    const id = result?.events?.RelayMessage?.returnValues?.messageID;

    id &&
      this.transfersApi.pushToSubmittedTransfers$({
        id,
        amount,
        direction: Direction.Eth2Sub,
        ethAddress: fromAddress,
        subAddress: to,
        status: Status.Pending,
      });
  }
}

async function getEthAccount(web3: Web3): Promise<string | null> {
  // Modern dapp browsers...
  if (window.ethereum) {
    try {
      // Request account access
      await window.ethereum.enable();
    } catch (error) {
      console.error('User denied account access');
      throw error;
    }
  }

  const accounts = await web3.eth.getAccounts();
  return accounts[0] || null;
}
