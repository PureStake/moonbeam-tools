// This script is specific to the moonbeam foundation
// It allows to verify proxy announcement against transfers from a csv file

import chalk from "chalk";
import yargs from "yargs";
import fs from "fs";
import { table } from "table";

import { getApiFor, NETWORK_YARGS_OPTIONS, numberWithCommas } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number to look into",
    },
    csv: {
      type: "string",
      description: "csv file to read from (format: 0x1234.....,150)",
      demandOption: true,
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);
  const csvData = fs.readFileSync(argv.csv);
  const lines = csvData.toString().split(/\r?\n/);
  const apiAt = argv.at ? await api.at(await api.rpc.chain.getBlockHash(argv.at)) : api;
  console.log(`Loading ${lines.length} lines from ${argv.csv}`);

  // Load asycnhronously all data
  const announcementGroups = await apiAt.query.proxy.announcements.entries();

  const allAnnouncements = {};
  for (const announcementTuple of announcementGroups) {
    const from = `0x${announcementTuple[0].toString().slice(-40).toLowerCase()}`;
    const announcements = announcementTuple[1][0];

    announcements.forEach((announcement: any) => {
      const real = announcement.real.toString().toLowerCase();
      const callHash = announcement.callHash.toString();
      allAnnouncements[callHash] = {
        from,
        real,
        callHash,
      };
    });
  }
  console.log(`Found ${Object.keys(allAnnouncements).length} announcements on-chain`);
  const batches: {
    [batchUUID: string]: {
      to: string;
      amount: string;
      call: any;
    }[];
  } = {};

  const sumByAddress = {};
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const data = line.split(",");
    if (data.length != 5) {
      throw new Error(`Invalid data line ${index}`);
    }
    const to = data[2].toLowerCase().replace(/"/g, "");
    const amount = data[3].toLowerCase().replace(/"/g, "");
    const batchUUID = data[4].toLowerCase().replace(/"/g, "");

    if (!batches[batchUUID]) {
      batches[batchUUID] = [];
    }
    batches[batchUUID].push({
      to,
      amount,
      call: api.tx.balances.transfer(to, BigInt(amount) * 10n ** 18n),
    });
  }

  const tableData = [["Batch", "From", "To", "Amount", "Verified"]].concat(
    Object.keys(batches)
      .map((batchUUID) => {
        const batch = batches[batchUUID];
        const batchTx = api.tx.utility.batchAll([
          ...batch.map((b) => b.call),
          api.tx.system.remark(batchUUID),
        ]);
        const announcement = allAnnouncements[batchTx.method.hash.toString()];
        return batches[batchUUID].map((call) => {
          if (announcement) {
            sumByAddress[announcement.real] =
              (sumByAddress[announcement.real] || 0) + Number(call.amount);
          }
          return [
            batchUUID,
            announcement?.real,
            call.to,
            numberWithCommas(call.amount),
            !!announcement ? chalk.green("true") : chalk.red("false"),
          ];
        });
      })
      .flat(),
    ...Object.keys(sumByAddress).map((from) => [
      ["Total", from, "", numberWithCommas(sumByAddress[from]), ""],
    ])
  );

  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length - Object.keys(sumByAddress).length ||
        lineIndex == tableData.length,
      columns: [
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "right" },
        { alignment: "left" },
      ],
    })
  );

  await api.disconnect();
};

main();
