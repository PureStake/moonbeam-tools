// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";
import chalk from "chalk";
import { table } from "table";
import "@polkadot/api-augment";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "at given block (past or future)",
      conflicts: ["in"],
    },
    para: {
      type: "number",
      description: "filter given parachain id",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  const [channelRequets, channels] = await Promise.all([
    apiAt.query.hrmp.hrmpOpenChannelRequests.entries(),
    apiAt.query.hrmp.hrmpChannels.entries(),
  ]);

  const filterPara = ([key, data]) => {
    const senderKey = api.registry.createType("ParaId", key.toU8a().slice(-8, -4));
    const receiverKey = api.registry.createType("ParaId", key.toU8a().slice(-4));
    if (!argv.para) {
      return true;
    }
    return senderKey.toNumber() == argv.para || receiverKey.toNumber() == argv.para;
  };

  const tableData = (
    [["Sender", "Receiver", "Status", "Messages", "Capacity", "Head"]] as any[]
  ).concat(
    channels.filter(filterPara).map(([key, data], index) => {
      const channel = data.unwrap();
      const senderKey = api.registry.createType("ParaId", key.toU8a().slice(-8, -4));
      const receiverKey = api.registry.createType("ParaId", key.toU8a().slice(-4));
      return [
        senderKey,
        receiverKey,
        chalk.green("Open"),
        channel.msgCount,
        channel.maxCapacity,
        channel.mqcHead,
      ];
    }),
    channelRequets.filter(filterPara).map(([key, data], index) => {
      const request = data.unwrap();
      const senderKey = api.registry.createType("ParaId", key.toU8a().slice(-8, -4));
      const receiverKey = api.registry.createType("ParaId", key.toU8a().slice(-4));
      return [senderKey, receiverKey, chalk.yellow("Pending"), "", request.maxCapacity, ""];
    })
  );

  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length ||
        lineIndex == channels.length + 1,
    })
  );
  await api.disconnect();
};

main();
