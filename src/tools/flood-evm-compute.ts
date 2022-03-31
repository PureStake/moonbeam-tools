// This script is expected to run against a parachain network (using launch.ts script)

import { ALITH_PRIVATE_KEY } from "../utils/constants";
import { compileSolidity } from "../utils/web3/solidity";
import { Keyring } from "@polkadot/api";

import * as rlp from "rlp";
import yargs from "yargs";
import { getMonitoredApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import Web3 from "web3";
import { callContract, deployContract } from "../utils/web3/contracts";

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

// Weird computation contract

const storageSource = `
pragma solidity>= 0.8.0;

contract Storage {
  mapping(uint => uint256) public bloat;
  uint256 sum = 0;
  function store(uint storage_item, uint value, uint loop) external returns (uint result) {
    for (uint i=0; i<loop; i++) {
      if (bloat[storage_item] == 0) {
        bloat[storage_item] = value;
      }
      bloat[storage_item] = bloat[storage_item] * i;
      sum = sum + i;
    }
    return bloat[storage_item] ;
  }
}`;

const computerSource = `
pragma solidity>= 0.8.0;

interface Storage {
  function store(uint storage_item, uint value, uint loop) external returns (uint result);
}

contract Computer {
  Storage internal story = Storage(0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3);
  
  mapping(uint => uint256) public bloat;
  uint256 sum = 0;

  function compute(uint storage_item, uint loop) public {
    for (uint i=0; i<loop; i++) {
      if (i % 4 == 3) {
        bloat[storage_item] = bloat[storage_item] + story.store(storage_item + i,  i, i / 4);
      }
      sum = sum + i;
    }
    bloat[storage_item + loop] = sum;
  }
}`;

const main = async () => {
  const web3 = new Web3(argv["eth-url"]);
  const polkadotApi = await getMonitoredApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const fromAccount = await keyring.addFromUri(argv.from);
  const deployer = web3.eth.accounts.privateKeyToAccount(argv.from);
  const storageContractAddress =
    "0x" + web3.utils.sha3(rlp.encode([deployer.address, 0]) as any).substr(26);
  const computerContractAddress =
    "0x" + web3.utils.sha3(rlp.encode([deployer.address, 1]) as any).substr(26);
  const storageContract = compileSolidity(storageSource, "Storage");
  const computercontract = compileSolidity(computerSource, "Computer");

  await Promise.all([
    deployContract(web3, storageContract, deployer, 0),
    deployContract(web3, computercontract, deployer, 1),
  ]);

  const computeWeight = {
    "0.15": { funcName: "compute", params: [1, 1], gasLimit: 50000 }, // 0.15%
    "0.40": { funcName: "compute", params: [1, 5], gasLimit: 100000 }, // 0.40%
    "0.75": { funcName: "compute", params: [1, 15], gasLimit: 200000 }, // 0.75%
  };

  let fromNonce = (await polkadotApi.rpc.system.accountNextIndex(fromAccount.address)).toNumber();

  const testSuite = new Array(argv.count).fill(computeWeight["0.40"]);

  console.log(`Starting to send transactions...`);
  while (true) {
    const pending = await polkadotApi.rpc.author.pendingExtrinsics();
    if (pending.length < argv.threshold) {
      await Promise.all(
        testSuite.map((compute) => {
          callContract(
            web3,
            computercontract,
            computerContractAddress,
            { ...compute, params: [compute.params[0], fromNonce] },
            deployer,
            fromNonce++
          ).catch((e) => {});
        })
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await polkadotApi.disconnect();
  await (web3.currentProvider as any).disconnect();
  console.log(`Finished`);
};

main();
