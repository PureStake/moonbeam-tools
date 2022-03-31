// This script is expected to run against a parachain network (using launch.ts script)
import { ApiPromise, WsProvider } from "@polkadot/api";
import yargs from "yargs";
import { mapExtrinsics, promiseConcurrent } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    url: {
      type: "string",
      description: "Websocket url",
      string: true,
      demandOption: true,
    },
    from: {
      type: "number",
      description: "from block number (included)",
      demandOption: true,
    },
    to: {
      type: "number",
      description: "to block number (included)",
      demandOption: true,
    },
  }).argv;

const printDOTs = (value: bigint, decimals = 4) => {
  const power = 10n ** (10n - BigInt(decimals));
  const decimal_power = 10 ** decimals;
  if (decimals > 0) {
    return (Number(value / power) / decimal_power).toFixed(decimals).padStart(5 + decimals, " ");
  }
  return (value / power).toString().padStart(5, " ");
};

const main = async () => {
  const api = await ApiPromise.create({
    provider: new WsProvider(argv.url),
  });

  const toBlockNumber = argv.to;
  const fromBlockNumber = argv.from;

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);
  let contributors = {};
  let blockNumbers = [];
  for (let i = argv.from; i <= argv.to; i++) {
    blockNumbers.push(i);
  }

  await promiseConcurrent(
    20,
    async (blockNumber) => {
      const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
      const records = await api.query.system.events.at(blockHash);

      const contrib = records.find(
        ({ event }) => event.section == "crowdloan" && event.method == "Contributed"
      );
      if (contrib) {
        const [account, paraId, amount] = contrib.event.data as any;
        if (!contributors[paraId.toString()]) {
          contributors[paraId.toString()] = {};
        }
        const para = contributors[paraId.toString()];
        if (!para[account.toString()]) {
          para[account.toString()] = {
            count: 0,
            amount: 0n,
          };
        }
        const contributor = para[account.toString()];
        contributor.count++;
        contributor.amount += amount.toBigInt();
      }
    },
    blockNumbers
  );

  for (const paraId in contributors) {
    console.log(`=== ${paraId}`);
    const para = contributors[paraId];
    const accounts = Object.keys(para).sort((a, b) =>
      para[a].amount > para[b].amount ? 1 : para[a].amount < para[b].amount ? -1 : 0
    );
    for (const account of accounts) {
      console.log(
        ` - ${account.padStart(48, " ")} [${para[account].count
          .toString()
          .padStart(6)}x]: ${printDOTs(para[account].amount)}`
      );
    }
    console.log(`\n`);
  }
  console.log(`Total blocks: ${argv.to - argv.from}`);

  await api.disconnect();
};

main();
