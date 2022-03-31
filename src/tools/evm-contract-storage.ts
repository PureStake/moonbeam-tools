// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";
import { table } from "table";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    contract: {
      type: "string",
      description: "address of the contract",
      demandOption: true,
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);
  const apiAt = argv.at ? await api.at(await api.rpc.chain.getBlockHash(argv.at)) : api;

  const contractAddress = api.registry.createType("EthereumAccountId", argv.contract).toString();

  const contractStorages = (await apiAt.query.evm.accountStorages.entries(contractAddress)) as any;

  console.log(`key,value`);
  for (const storage of contractStorages) {
    const key = storage[0].toHex().slice(2);
    const address = `0x${key.slice(64 + 32, 64 + 32 + 40)}`;
    const h1 = `0x${key.slice(64 + 32 + 40 + 32, 64 + 32 + 40 + 32 + 64)}`;
    const storageData = storage[1].toHex();
    console.log(`${h1},${storageData}`);
  }

  await api.disconnect();
};

main();
