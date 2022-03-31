// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";

import { DispatchInfo } from "@polkadot/types/interfaces";

import { exploreBlockRange, getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const WEIGHT_PER_GAS = 1_000_000_000_000n / 40_000_000n;

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    from: {
      type: "number",
      description: "from block number (included)",
    },
    to: {
      type: "number",
      description: "to block number (included)",
    },
    verbose: {
      type: "boolean",
      default: false,
      description: "display every tx fees",
    },
  }).argv;

const printMOVRs = (value: bigint, decimals = 4) => {
  const power = 10n ** (18n - BigInt(decimals));
  const decimal_power = 10 ** decimals;
  if (decimals > 0) {
    return (Number(value / power) / decimal_power).toFixed(decimals).padStart(3 + decimals, " ");
  }
  return (value / power).toString().padStart(3, " ");
};

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  // Set to and from block numbers
  const toBlockNumber = argv.to || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  const fromBlockNumber = argv.from || toBlockNumber;

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);
  let sumBlockFees = 0n;
  let sumBlockBurnt = 0n;
  let blockCount = 0;

  // Get from block hash and totalSupply
  const fromPreBlockHash = (await api.rpc.chain.getBlockHash(fromBlockNumber - 1)).toString();
  const fromPreSupply = await (await api.at(fromPreBlockHash)).query.balances.totalIssuance();
  let previousBlockHash = fromPreBlockHash;

  // Get to block hash and totalSupply
  const toBlockHash = (await api.rpc.chain.getBlockHash(toBlockNumber)).toString();
  const toSupply = await (await api.at(toBlockHash)).query.balances.totalIssuance();

  // fetch block information for all blocks in the range
  await exploreBlockRange(
    api,
    { from: fromBlockNumber, to: toBlockNumber, concurrency: 5 },
    async (blockDetails) => {
      blockCount++;
      let blockFees = 0n;
      let blockBurnt = 0n;

      // iterate over every extrinsic
      for (const { events, extrinsic, fee } of blockDetails.txWithEvents) {
        // This hash will only exist if the transaction was executed through ethereum.
        let ethereumAddress = "";

        if (extrinsic.method.section == "ethereum") {
          // Search for ethereum execution
          events.forEach((event) => {
            if (event.section == "ethereum" && event.method == "Executed") {
              ethereumAddress = event.data[0].toString();
            }
          });
        }

        let txFees = 0n;
        let txBurnt = 0n;

        // For every extrinsic, iterate over every event and search for ExtrinsicSuccess or ExtrinsicFailed
        for (const event of events) {
          if (
            event.section == "system" &&
            (event.method == "ExtrinsicSuccess" || event.method == "ExtrinsicFailed")
          ) {
            const dispatchInfo =
              event.method == "ExtrinsicSuccess"
                ? (event.data[0] as DispatchInfo)
                : (event.data[1] as DispatchInfo);

            // We are only interested in fee paying extrinsics:
            // Either ethereum transactions or signed extrinsics with fees (substrate tx)
            if (
              dispatchInfo.paysFee.isYes &&
              (!extrinsic.signer.isEmpty || extrinsic.method.section == "ethereum")
            ) {
              if (extrinsic.method.section == "ethereum") {
                // For Ethereum tx we caluculate fee by first converting weight to gas
                const gasFee = dispatchInfo.weight.toBigInt() / WEIGHT_PER_GAS;
                // And then multiplying by gasPrice
                txFees = gasFee * (extrinsic.method.args[0] as any).gasPrice.toBigInt();
              } else {
                // For a regular substrate tx, we use the partialFee
                txFees = fee.partialFee.toBigInt();
              }
              txBurnt += (txFees * 80n) / 100n; // 20% goes to treasury

              blockFees += txFees;
              blockBurnt += txBurnt;

              const origin = extrinsic.signer.isEmpty
                ? ethereumAddress
                : extrinsic.signer.toString();

              // Get balance of the origin account both before and after extrinsic execution
              const fromBalance = await (
                await api.at(previousBlockHash)
              ).query.system.account(origin);
              const toBalance = await (
                await api.at(blockDetails.block.hash)
              ).query.system.account(origin);

              // Verbose option will display tx fee and balance change for each extrinsic
              if (argv.verbose) {
                console.log(
                  ` ${extrinsic.method.section == "ethereum" ? "[Eth]" : "[Sub]"}${
                    event.method == "ExtrinsicSuccess" ? "(✔)" : "(X)"
                  }${origin.toString()}: ${txFees.toString().padStart(19, " ")} (${printMOVRs(
                    txFees,
                    5
                  )} MOVR) (Balance diff: ${(
                    toBalance.data.free.toBigInt() - fromBalance.data.free.toBigInt()
                  )
                    .toString()
                    .padStart(20, " ")})(${printMOVRs(
                    toBalance.data.free.toBigInt() - fromBalance.data.free.toBigInt(),
                    5
                  )} MOVR)`
                );
              }
            }
          }
        }
        // Then search for Deposit event from treasury
        // This is for bug detection when the fees are not matching the expected value
        for (const event of events) {
          if (event.section == "treasury" && event.method == "Deposit") {
            const deposit = (event.data[0] as any).toBigInt();
            // Compare deposit event amont to what should have been sent to deposit (if they don't match, which is not a desired behavior)
            if (txFees - txBurnt !== deposit) {
              console.log("Desposit Amount Discrepancy!");
              console.log(`fees not burnt : ${(txFees - txBurnt).toString().padStart(30, " ")}`);
              console.log(`       deposit : ${deposit.toString().padStart(30, " ")}`);
            }
          }
        }
      }
      sumBlockFees += blockFees;
      sumBlockBurnt += blockBurnt;
      console.log(`#${blockDetails.block.header.number} Fees : ${printMOVRs(blockFees, 4)} MOVRs`);
      previousBlockHash = blockDetails.block.hash.toString();
    }
  );
  // Print total and average for the block range
  console.log(
    `Total blocks : ${blockCount}, ${printMOVRs(
      sumBlockFees / BigInt(blockCount),
      4
    )}/block, ${printMOVRs(sumBlockFees, 4)} Total`
  );

  // Log difference in supply, we should be equal to the burnt fees
  console.log(
    `  supply diff: ${(fromPreSupply.toBigInt() - toSupply.toBigInt())
      .toString()
      .padStart(30, " ")}`
  );
  console.log(`  burnt fees : ${sumBlockBurnt.toString().padStart(30, " ")}`);
  console.log(`  total fees : ${sumBlockFees.toString().padStart(30, " ")}`);

  await api.disconnect();
};

main();
