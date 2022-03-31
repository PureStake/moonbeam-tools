// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    address: {
      type: "string",
      description: "The address to look at",
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const blockNumber = argv.at || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toString();
  const apiAt = await api.at(blockHash);

  const account = await apiAt.query.system.account(argv.address);

  console.log(
    `#${blockNumber} - ${
      argv.address
    } [free: ${account.data.free.toBigInt()}, reserved: ${account.data.reserved.toBigInt()}, miscFrozen: ${account.data.miscFrozen.toBigInt()}, feeFrozen: ${account.data.feeFrozen.toBigInt()}]`
  );
  api.disconnect();
};

main();
