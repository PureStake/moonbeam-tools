// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    collator: {
      type: "string",
      description: "address of the collator",
      demandOption: true,
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const formattedCollator = api.registry.createType("EthereumAccountId", argv.collator).toString();

  const roundInfo = (await api.query.parachainStaking.round()) as any;
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const roundBlockLefts = roundInfo.first.toNumber() - blockNumber;

  const delegatorState = await api.query.parachainStaking.delegatorState.entries();

  let totalDelegations = 0;
  const requests: { id: any; request: any }[] = [];
  for (const state of delegatorState) {
    const stateData = (state[1] as any).unwrap();
    totalDelegations += stateData.delegations.length;
    if (stateData.requests.revocationsCount > 0) {
      // console.log(stateData.toJSON());
      if (stateData.requests.requests.toJSON()[formattedCollator]) {
        requests.push({
          id: stateData.id,
          request: stateData.requests.requests.toJSON()[formattedCollator],
        });
      }
    }
  }

  let totalRevoked = 0n;

  for (const req of requests.sort((a, b) => a.request.whenExecutable - b.request.whenExecutable)) {
    totalRevoked += req.request.action == "Revoke" ? BigInt(req.request.amount) : 0n;
    const tokens = BigInt(req.request.amount) / 10n ** 18n;
    const tokenString =
      tokens > 20000n
        ? chalk.red(tokens.toString().padStart(6))
        : tokens > 2000n
        ? chalk.yellow(tokens.toString().padStart(6))
        : tokens.toString().padStart(6);

    const blockLefts =
      (req.request.whenExecutable - roundInfo.current.toNumber()) * roundInfo.length.toNumber() +
      roundBlockLefts;
    const timeLeft = blockLefts * 12;
    console.log(
      `#${req.request.whenExecutable} (${Math.floor(timeLeft / 60 / 60)
        .toString()
        .padStart(5)}h): ${req.request.action
        .toString()
        .padStart(10)} ${tokenString} by ${req.id.toHex()}`
    );
  }
  console.log(`Pending revoke: ${totalRevoked / 10n ** 18n}`);
  console.log(`All collators delegations: ${totalDelegations}`);

  await api.disconnect();
};

main();
