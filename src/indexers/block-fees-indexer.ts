// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import "@moonbeam-network/api-augment";

import type { u128 } from "@polkadot/types";
import type {
  EthereumTransactionTransactionV2,
  PalletCollectiveVotes,
} from "@polkadot/types/lookup";
import type {
  DispatchInfo,
  EthTransaction,
  ParachainInherentData,
} from "@polkadot/types/interfaces";

import { exploreBlockRange, getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const debug = require("debug")("indexer:fee");

const WEIGHT_PER_GAS = 1_000_000_000_000n / 40_000_000n;

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    verbose: {
      type: "boolean",
      default: false,
      description: "display every tx fees",
    },
    first: {
      type: "number",
      description: "Number of block to start indexing (default: 1)",
    },
    blocks: {
      type: "number",
      description: "Number of block",
      default: 2000,
      demandOption: true,
    },
    concurrency: {
      type: "number",
      description: "number of concurrent requests",
      default: 10,
      demandOption: true,
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

// Prevent getting stuck
setTimeout(() => {
  process.exit(1); // exit=true;
}, 300000);

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);
  await api.isReady;

  const runtimeName = api.runtimeVersion.specName.toString();
  const paraId = (await api.query.parachainInfo.parachainId()).toNumber();
  const db = await open({
    filename: `./db-fee.${runtimeName}.${paraId}.db`,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  });

  //Initialize
  const createTxDbQuery = `CREATE TABLE IF NOT EXISTS extrinsics (
    extrinsic_id varchar(255) PRIMARY KEY,
    block_number INTEGER,
    bytes INTEGER,
    section TEXT,
    method TEXT,
    success BOOLEAN,
    pay_fee BOOLEAN,
    weight BIGINT,
    partial_fee BIGINT,
    treasury_deposit BIGINT,
    fee BIGINT,
    runtime INTEGER,
    collator_mint BIGINT
  );`;

  //Initialize
  const createLogDbQuery = `CREATE TABLE IF NOT EXISTS logs (
    extrinsic_id varchar(255) PRIMARY KEY,
    block_number INTEGER,
    topic1 VARCHAR(66),
    topic2 VARCHAR(66),
    topic3 VARCHAR(66),
    topic4 VARCHAR(66),
    address VARCHAR(42),
    data TEXT,
  );`;

  const createBlockDbQuery = `CREATE TABLE IF NOT EXISTS blocks (
    block_number INTEGER PRIMARY KEY,
    weight BIGINT,
    treasury_deposit BIGINT,
    treasury_amount BIGINT,
    total_issuance BIGINT,
    fee BIGINT,
    runtime INTEGER
  );`;

  try {
    await db.run(createTxDbQuery);
    await db.run(createBlockDbQuery);
  } catch (e) {
    console.trace(e);
    process.exit(1);
  }

  // Retrieve latest known block to resume operation.
  // If a block was partially processed already, the block table wouldn't be updated and
  // that given block would get processed again (extrinsic are unique so no duplicates)
  const latestKnownBlock =
    (await db.get(`SELECT block_number FROM blocks ORDER BY block_number DESC LIMIT 1`))
      ?.block_number || 0;
  console.log(`Latest known block: ${latestKnownBlock}`);

  let fromBlockNumber: number;
  if (latestKnownBlock != 0) {
    fromBlockNumber = latestKnownBlock + 1;
  } else if (argv.first !== undefined && argv.first !== null) {
    fromBlockNumber = argv.first;
  } else {
    fromBlockNumber = 1;
  }

  // Set to and from block numbers
  const toBlockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber() - 1;

  if (toBlockNumber < fromBlockNumber) {
    return;
  }

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);
  let sumBlockFees = 0n;
  let sumBlockBurnt = 0n;
  let blockCount = 0;

  // Get from block hash and totalSupply
  const fromPreBlockHash = (await api.rpc.chain.getBlockHash(fromBlockNumber - 1)).toString();
  const fromPreSupply = await (await api.at(fromPreBlockHash)).query.balances.totalIssuance();

  // Get to block hash and totalSupply
  const toBlockHash = (await api.rpc.chain.getBlockHash(toBlockNumber)).toString();
  const toSupply = await (await api.at(toBlockHash)).query.balances.totalIssuance();

  // Load data
  const treasuryAccountId = `0x6d6f646C${(await api.consts.treasury.palletId)
    .toString()
    .slice(2)}0000000000000000`;

  // fetch block information for all blocks in the range
  await exploreBlockRange(
    api,
    { from: fromBlockNumber, to: toBlockNumber, concurrency: argv.concurrency },
    async (blockDetails) => {
      try {
        blockCount++;
        let blockFees = 0n;
        let blockBurnt = 0n;
        let blockWeight = 0n;
        let blockTreasure = 0n;

        debug(
          `Processing ${blockDetails.block.header.number.toString()}: ${blockDetails.block.header.hash.toString()}`
        );

        const apiAt = await api.at(blockDetails.block.header.hash);
        const apiPreviousAt = await api.at(blockDetails.block.header.parentHash);

        const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
        const runtimeVersion = upgradeInfo.specVersion.toNumber();
        const baseFeePerGas =
          runtimeVersion >= 1200 ? (await apiAt.query.baseFee.baseFeePerGas()).toBigInt() : 0n;

        // Might not work on first moonbase runtimes
        const authorId =
          blockDetails.block.extrinsics
            .find((tx) => tx.method.section == "authorInherent" && tx.method.method == "setAuthor")
            ?.args[0]?.toString() ||
          blockDetails.block.header.digest.logs
            .find(
              (l) =>
                l.isPreRuntime &&
                l.asPreRuntime.length > 0 &&
                l.asPreRuntime[0].toString() == "nmbs"
            )
            ?.asPreRuntime[1]?.toString();

        // Stores if a member did vote for the same proposal in the same block
        const hasMemberVoted: {
          [accountId: string]: { proposal: { [proposalKey: string]: true } };
        } = {};

        // iterate over every extrinsic
        for (const index of blockDetails.txWithEvents.keys()) {
          const { events, extrinsic, fees } = blockDetails.txWithEvents[index];
          // This hash will only exist if the transaction was executed through ethereum.

          let txFees = 0n;
          let txBurnt = 0n;
          let collatorDeposit = 0n;

          // For every extrinsic, iterate over every event and search for ExtrinsicSuccess or ExtrinsicFailed
          const extrinsicResult = events.find(
            (event) =>
              event.section == "system" &&
              (event.method == "ExtrinsicSuccess" || event.method == "ExtrinsicFailed")
          );
          const isSuccess = extrinsicResult.method == "ExtrinsicSuccess";

          const dispatchInfo = isSuccess
            ? (extrinsicResult.data[0] as DispatchInfo)
            : (extrinsicResult.data[1] as DispatchInfo);
          debug(`  - Extrinsic ${extrinsic.method.toString()}: ${isSuccess ? "Ok" : "Failed"}`);

          if (
            extrinsic.method.section == "parachainSystem" &&
            extrinsic.method.method == "setValidationData"
          ) {
            // XCM transaction are not extrinsic but consume fees.

            const payload = extrinsic.method.args[0] as ParachainInherentData;
            if (runtimeVersion < 1700) {
              // There is no precise way to compute fees for now:
              events
                .filter((event, index) => event.section == "treasury" && event.method == "Deposit")
                .forEach((depositEvent) => {
                  const deposit = (depositEvent.data[0] as u128).toBigInt();
                  txFees += deposit * 5n;
                  txBurnt += deposit * 4n;
                });
            }
          } else if (
            dispatchInfo.paysFee.isYes &&
            (!extrinsic.signer.isEmpty ||
              extrinsic.method.section == "ethereum" ||
              extrinsic.method.section == "parachainSystem")
          ) {
            // We are only interested in fee paying extrinsics:
            // Either ethereum transactions or signed extrinsics with fees (substrate tx)

            if (extrinsic.method.section == "ethereum") {
              const payload = extrinsic.method.args[0] as EthereumTransactionTransactionV2;
              // For Ethereum tx we caluculate fee by first converting weight to gas
              let gasUsed = dispatchInfo.weight.toBigInt() / WEIGHT_PER_GAS;

              let gasPriceParam = payload.isLegacy
                ? payload.asLegacy?.gasPrice.toBigInt()
                : payload.isEip2930
                ? payload.asEip2930?.gasPrice.toBigInt()
                : payload.isEip1559
                ? // If gasPrice is not indicated, we should use the base fee defined in that block
                  payload.asEip1559?.maxFeePerGas.toBigInt() || baseFeePerGas
                : (payload as any as EthTransaction).gasPrice.toBigInt();

              let gasLimitParam =
                (payload.isLegacy
                  ? payload.asLegacy?.gasLimit.toBigInt()
                  : payload.isEip2930
                  ? payload.asEip2930?.gasLimit.toBigInt()
                  : payload.isEip1559
                  ? payload.asEip1559?.gasLimit.toBigInt()
                  : (payload as any as EthTransaction)?.gasLimit.toBigInt()) || 15000000n;

              let gasBaseFee = payload.isEip1559 ? baseFeePerGas : gasPriceParam;
              let gasTips = payload.isEip1559
                ? payload.asEip1559.maxPriorityFeePerGas.toBigInt() <
                  payload.asEip1559.maxFeePerGas.toBigInt() - gasBaseFee
                  ? payload.asEip1559.maxPriorityFeePerGas.toBigInt()
                  : payload.asEip1559.maxFeePerGas.toBigInt() - gasBaseFee
                : 0n;

              if (isSuccess && runtimeVersion >= 800 && runtimeVersion < 1000) {
                // Bug where an account with balance == gasLimit * fee loses all its balance into fees
                const treasuryDepositEvent = events.find(
                  (event, index) => event.section == "treasury" && event.method == "Deposit"
                );
                const treasuryDeposit = (treasuryDepositEvent.data[0] as any).toBigInt();

                if (
                  treasuryDeposit !=
                  gasUsed * gasPriceParam - (gasUsed * gasPriceParam * 80n) / 100n
                ) {
                  gasUsed = gasLimitParam;
                }
              }

              if (payload.isEip1559 && runtimeVersion < 1400) {
                // Bug where maxPriorityFee is added to the baseFee even if over the maxFeePerGas.
                // Is removed in runtime 1400
                gasTips = payload.asEip1559.maxPriorityFeePerGas.toBigInt();
              }
              let gasFee = gasBaseFee + gasTips;

              // Bug where a collator receives unexpected fees ("minted")
              const collatorDepositEvent = events.find(
                (event) =>
                  event.section == "balances" &&
                  event.method == "Deposit" &&
                  authorId == event.data[0].toString()
              );

              if (collatorDepositEvent) {
                const extraFees = payload.isEip1559 ? gasTips : gasFee - baseFeePerGas;
                collatorDeposit = (collatorDepositEvent.data[1] as any).toBigInt();
                // console.log(`collator deposit : ${collatorDeposit.toString().padStart(30, " ")}`);

                if (collatorDeposit !== extraFees * gasUsed) {
                  console.log(
                    `[Bug] Collator Mint Discrepancy: [${blockDetails.block.header.number.toString()}-${index}:` +
                      ` ${extrinsic.method.section.toString()}.${extrinsic.method.method.toString()} (${
                        payload.type
                      })- ${runtimeVersion}]`
                  );
                  console.log(`collator deposit : ${collatorDeposit.toString().padStart(30, " ")}`);
                  console.log(`         gasCost : ${gasBaseFee.toString().padStart(30, " ")}`);
                  console.log(`          gasFee : ${gasFee.toString().padStart(30, " ")}`);
                  console.log(` gasPrice(param) : ${gasPriceParam.toString().padStart(30, " ")}`);
                  console.log(
                    `    priority fee : ${
                      payload.isEip1559
                        ? payload.asEip1559.maxPriorityFeePerGas
                            .toBigInt()
                            .toString()
                            .padStart(30, " ")
                        : ""
                    }`
                  );
                  console.log(
                    `         max fee : ${
                      payload.isEip1559
                        ? payload.asEip1559.maxFeePerGas.toBigInt().toString().padStart(30, " ")
                        : ""
                    }`
                  );
                  console.log(`         gasUsed : ${gasUsed.toString().padStart(30, " ")}`);
                  console.log(
                    `            fees : ${(gasUsed * gasBaseFee).toString().padStart(30, " ")}`
                  );
                  console.log(`       extraFees : ${extraFees.toString().padStart(30, " ")}`);
                  console.log(
                    `   expected mint : ${(extraFees * gasUsed).toString().padStart(30, " ")}`
                  );
                  console.log(extrinsic.toHex());
                  process.exit(1);
                }
              }

              // Bug where invalidNonce Tx could get included
              txFees = isSuccess ? gasUsed * gasFee : 0n;

              // 20% of Ethereum fees goes to treasury (after runtime 800)
              txBurnt = runtimeVersion >= 800 ? (txFees * 80n) / 100n : txFees;
            } else {
              let payFees = true;
              if (
                extrinsic.method.section == "parachainSystem" &&
                extrinsic.method.method == "enactAuthorizedUpgrade" &&
                isSuccess
              ) {
                // No fees to pay if successfully enacting an authorized upgrade
                payFees = false;
              } else if (extrinsic.method.section == "sudo") {
                // No fees to pay if sudo
                payFees = false;
              } else if (
                extrinsic.method.section == "evm" &&
                extrinsic.method.method == "hotfixIncAccountSufficients"
              ) {
                // No fees to pay if sudo
                payFees = runtimeVersion < 1500;
              } else if (
                // Vote for collective doesn't pay fee if it is the first vote for an account for the given proposal
                ["councilCollective", "techCommitteeCollective", "techComitteeCollective"].includes(
                  extrinsic.method.section
                ) &&
                isSuccess
              ) {
                if (extrinsic.method.method == "close") {
                  const disapproved = events.find((event) => event.method == "Disapproved");
                  // No fees are paid if collective disapproved the proposal
                  payFees = !disapproved;
                }
                if (extrinsic.method.method == "vote") {
                  const votedEvent = events.find((event) => event.method == "Voted");
                  const account = votedEvent.data[0].toString();
                  const hash = (extrinsic.method.args[0] as any).toString();
                  // combine the committee type with the hash to make it unique.
                  const hashKey = `${extrinsic.method.section}_${hash}`;
                  const votes = (
                    (await apiPreviousAt.query[extrinsic.method.section].voting(hash)) as any
                  ).unwrap() as PalletCollectiveVotes;

                  const firstVote =
                    !votes.ayes.includes(account) &&
                    !votes.nays.includes(account) &&
                    !hasMemberVoted[account]?.proposal[hashKey];

                  if (!hasMemberVoted[account]) {
                    hasMemberVoted[account] = {
                      proposal: {},
                    };
                  }
                  hasMemberVoted[account].proposal[hashKey] = true;

                  payFees = !firstVote;
                }
              }

              if (payFees) {
                // TODO: add link to formula for totalFees; (see types.ts for now)
                txFees = fees.totalFees;
                txBurnt = (txFees * 80n) / 100n; // 80% goes to burnt (20% - round-up will go to treasury)
              }
            }
            debug(`    Validated`);
          }
          blockWeight += dispatchInfo.weight.toBigInt();
          blockFees += txFees;
          blockBurnt += txBurnt;
          // Then search for Deposit event from treasury
          // This is for bug detection when the fees are not matching the expected value
          const treasureDepositEvents = events.filter(
            (event) => event.section == "treasury" && event.method == "Deposit"
          );
          const treasureDeposit = treasureDepositEvents.reduce(
            (p, e) => p + (e.data[0] as any).toBigInt(),
            0n
          );
          blockTreasure += treasureDeposit;

          if (txFees - txBurnt !== treasureDeposit) {
            console.log(
              `Desposit Amount Discrepancy: [${blockDetails.block.header.number.toString()}-${index}:` +
                ` ${extrinsic.method.section.toString()}.${extrinsic.method.method.toString()} - ${runtimeVersion}]`
            );
            console.log(`     base fees : ${fees.baseFee.toString().padStart(30, " ")}`);
            console.log(` +    len fees : ${fees.lenFee.toString().padStart(30, " ")}`);
            console.log(` + weight fees : ${fees.weightFee.toString().padStart(30, " ")}`);
            console.log(` =  total fees : ${fees.totalFees.toString().padStart(30, " ")}`);
            console.log(`fees not burnt : ${(txFees - txBurnt).toString().padStart(30, " ")}`);
            console.log(`       deposit : ${treasureDeposit.toString().padStart(30, " ")}`);
            console.log(extrinsic.toHex());
            process.exit();
          }

          const values = [
            `${blockDetails.block.header.number.toNumber()}-${index}`,
            blockDetails.block.header.number.toNumber(),
            extrinsic.toU8a().length,
            extrinsic.method.section,
            extrinsic.method.method,
            isSuccess,
            dispatchInfo.paysFee.isYes,
            dispatchInfo.weight.toBigInt().toString(),
            fees.totalFees.toString(),
            treasureDeposit.toString(),
            txFees.toString(),
            runtimeVersion,
            collatorDeposit.toString(),
          ];
          await db.get(
            `INSERT OR IGNORE INTO extrinsics values(${values.map(() => `?`).join(",")})`,
            values
          );
        }

        sumBlockFees += blockFees;
        sumBlockBurnt += blockBurnt;
        console.log(
          `    - ${blockDetails.block.header.number} (${runtimeVersion}) Fees : ${blockFees} - ${sumBlockFees} - ${blockBurnt} - ${sumBlockBurnt}`
        );

        const [previousTreasure, treasure, issuance] = await Promise.all([
          apiPreviousAt.query.system.account(treasuryAccountId).then((d) => d.data.free.toBigInt()),
          apiAt.query.system.account(treasuryAccountId).then((d) => d.data.free.toBigInt()),
          apiAt.query.balances.totalIssuance().then((d) => d.toBigInt()),
        ]);

        if (previousTreasure + blockTreasure !== treasure) {
          console.log(
            `Treasury Amount Discrepancy: [${blockDetails.block.header.number.toString()} [${runtimeVersion}]`
          );
          console.log(`previous treasury: ${previousTreasure.toString().padStart(30, " ")}`);
          console.log(`         treasury: ${treasure.toString().padStart(30, " ")}`);
          console.log(
            `expected treasury: ${(blockTreasure + previousTreasure).toString().padStart(30, " ")}`
          );
          console.log(`    block deposit: ${blockTreasure.toString().padStart(30, " ")}`);
        }
        const values = [
          blockDetails.block.header.number.toNumber(),
          blockWeight.toString(),
          blockTreasure.toString(),
          treasure.toString(),
          issuance.toString(),
          blockFees.toString(),
          runtimeVersion,
        ];

        await db.get(`INSERT INTO blocks values(${values.map(() => `?`).join(",")})`, values);
        // console.log(
        //   `                         Ending ${blockDetails.block.header.number.toNumber()}`
        // );
      } catch (e) {
        console.log(e);
        process.exit(1);
      }
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

  await db.close();
  await api.disconnect();
};

main();
