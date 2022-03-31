// This script is expected to run against a parachain network (using launch.ts script)

import { ALITH_PRIVATE_KEY } from "../utils/constants";
import { Keyring } from "@polkadot/api";
import { TransactionReceipt } from "web3-core";

import yargs from "yargs";
import { getMonitoredApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import Web3 from "web3";
import { customWeb3Request } from "../utils/web3/transactions";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "eth-url": {
      type: "string",
      description: "RPC url for Eth API",
      demandOption: true,
    },
    from: {
      type: "string",
      description: "Private key to transfer from",
      conflicts: ["to"],
    },
    threshold: {
      type: "number",
      description: "Minimum number of txs in the pool before refilling",
      default: 500,
    },
    count: {
      type: "number",
      description: "Number of txs to send when refilling",
      default: 200,
    },
  })
  .check(function (argv) {
    if (!argv.from && !argv.to) {
      argv.from = ALITH_PRIVATE_KEY;
    }
    return true;
  }).argv;

const hashes = {};
const sendTransfer = async (web3: Web3, from: any, nonce: number) => {
  // console.log(`Sending ${nonce}`)
  const tx = await web3.eth.accounts.signTransaction(
    {
      from: from.address,
      to: "0x17e9bfd55118c142e15d36200dcdabb3aa5a0ac9",
      gasPrice: web3.utils.toWei("1", "Gwei"),
      gas: 21000,
      value: web3.utils.toWei("1", "Gwei"),
      nonce: nonce++,
    },
    from.privateKey
  );

  const result = await customWeb3Request(web3, "eth_sendRawTransaction", [tx.rawTransaction]);
  if (result.error) {
    console.error(result.error);
    throw new Error(`Error sending transaction!`);
  }

  if (hashes[tx.transactionHash]) {
    console.log(`Conflict of hash: ${tx.transactionHash}`);
    console.log(JSON.stringify(hashes[tx.transactionHash], null, 2));
    console.log(`new`);
    console.log(JSON.stringify(tx, null, 2));
    process.exit(1);
  }
  hashes[tx.transactionHash] = tx;

  // console.log(`Transaction for Loop count ${loopCount} sent: ${tx.transactionHash}`);
  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    let rcpt: TransactionReceipt = await web3.eth.getTransactionReceipt(tx.transactionHash);
    if (rcpt) {
      //console.log(`Loop count ${loopCount} - block #${rcpt.blockNumber} (${rcpt.blockHash})`);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }
  throw new Error("Failed to send transaction (timeout)");
};

const main = async () => {
  const web3 = new Web3(argv["eth-url"]);
  const polkadotApi = await getMonitoredApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const fromAccount = await keyring.addFromUri(argv.from);

  let fromNonce = (await polkadotApi.rpc.system.accountNextIndex(fromAccount.address)).toNumber();
  console.log(`Sending from nonce ${fromNonce}`);

  console.log(`Starting to send transactions...`);
  while (true) {
    const pending = await polkadotApi.rpc.author.pendingExtrinsics();
    if (pending.length < argv.threshold) {
      new Array(argv.count).fill(0).map(() => {
        return polkadotApi.tx.system
          .remark("ok")
          .signAndSend(fromAccount, { nonce: fromNonce++ })
          .catch((e) => {
            console.log(e);
          });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await polkadotApi.disconnect();
  await (web3.currentProvider as any).disconnect();
  console.log(`Finished`);
};

main();
