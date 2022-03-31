// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";
import { table } from "table";

import { getAccountIdentities, getApiFor, NETWORK_YARGS_OPTIONS, numberWithCommas } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  // Load asycnhronously all data
  const dataPromise = Promise.all([
    api.rpc.chain.getHeader(blockHash),
    apiAt.query.parachainStaking.round() as Promise<any>,
    apiAt.query.parachainStaking.delegatorState.entries(),
    apiAt.query.parachainStaking.candidatePool() as Promise<any>,
    apiAt.query.parachainStaking.selectedCandidates() as Promise<any>,
    apiAt.query.parachainStaking.totalSelected() as Promise<any>,
  ]);

  const [candidateData] = await Promise.all([
    (
      apiAt.query.parachainStaking.candidateInfo || apiAt.query.parachainStaking.candidateState
    ).entries(),
  ]);
  const candidateNames = await getAccountIdentities(
    api,
    candidateData.map((c: any) => `0x${c[0].toHex().slice(-40)}`),
    blockHash
  );

  // Wait for data to be retrieved
  const [blockHeader, roundInfo, delegatorState, candidatePool, selectedCandidates, totalSelected] =
    await dataPromise;

  const candidates = candidateData.reduce((p, v: any, index: number) => {
    const candidate = v[1].unwrap();
    const id = `0x${v[0].toHex().slice(-40)}`;
    p[id] = {
      id,
      name: candidateNames[index].replace(/[\t\n]/g, "").slice(0, 42),
      totalDelegators: 0,
      isActive: (candidate.state || candidate.status).toString() == "Active",
      isSelected: selectedCandidates.find((c) => c.toHex() == id),
      totalDelegations: candidate.totalCounted.toBigInt(),
      totalRevokable: new Array(8).fill(0n),
      pendingRevoke: 0n,
    };
    return p;
  }, {});

  for (const state of delegatorState) {
    const stateData = (state[1] as any).unwrap();
    let totalDelegations = 0n;
    for (const delegation of stateData.delegations) {
      candidates[delegation.owner.toHex()].totalDelegators += 1;
      totalDelegations += delegation.amount.toBigInt();
    }
    // This is used to know how many delegation are left to count if the delegator is leaving
    const delegationLeft = stateData.delegations.reduce((p, delegation) => {
      p[delegation.owner.toHex()] = delegation;
      return p;
    }, {});

    const isLeavingAt = (stateData.status.isLeaving && stateData.status.asLeaving.toNumber()) || 0;
    for (const requestData of stateData.requests.requests) {
      const request = requestData[1].toJSON();
      const collatorId = request.collator.toLowerCase();
      // Checking because of bug allowing pending request even if no collator
      if (candidates[collatorId] && (!isLeavingAt || request.whenExecutable < isLeavingAt)) {
        candidates[collatorId].pendingRevoke += BigInt(request.amount);
        const day = Math.ceil(
          (Math.max(request.whenExecutable, roundInfo.current.toNumber()) -
            roundInfo.current.toNumber()) /
            4
        );
        delete delegationLeft[collatorId]; // The delegation will not count anymore if the delegator is leaving
        candidates[collatorId].totalRevokable[day] += BigInt(request.amount);
      }
    }
    if (isLeavingAt) {
      for (const collatorId of Object.keys(delegationLeft)) {
        const delegation = delegationLeft[collatorId];
        const day = Math.ceil(
          (Math.max(isLeavingAt, roundInfo.current.toNumber()) - roundInfo.current.toNumber()) / 4
        );
        candidates[collatorId].pendingRevoke += delegation.amount.toBigInt();
        candidates[collatorId].totalRevokable[day] += delegation.amount.toBigInt();
      }
    }
  }

  const candidateList = Object.keys(candidates)
    .sort((a, b) =>
      Number(
        (candidates[b].isActive ? candidates[b].totalDelegations : 0n) -
          (candidates[a].isActive ? candidates[a].totalDelegations : 0n)
      )
    )
    .map((a) => candidates[a]);

  const minCollator = candidateList[Math.min(candidateList.length - 1, totalSelected.toNumber())];
  const minCollatorFifth = candidateList[Math.floor((totalSelected.toNumber() * 4) / 5)];

  const candidateOffCount = candidateList.filter((c) => !c.isActive).length;
  const nextRoundSeconds =
    12 * (roundInfo.first.toNumber() + roundInfo.length.toNumber() - blockHeader.number.toNumber());

  const printColoredNumber = (value: bigint, total: bigint) => {
    const valueWithCommas = numberWithCommas(value / 10n ** 18n);
    return value > total / 10n
      ? chalk.red(valueWithCommas)
      : value > total / 20n
      ? chalk.yellow(valueWithCommas)
      : valueWithCommas;
  };

  const sumRevokable = new Array(8)
    .fill(0)
    .map((_, day) => candidateList.reduce((p, c) => p + c.totalRevokable[day], 0n));
  const tableData = (
    [
      [
        "Id",
        "Name",
        "Delegators",
        "Delegations",
        "Revokable",
        ...new Array(7).fill(0).map((_, i) => `${i + 1} day`),
        "Pending",
      ],
    ] as any[]
  ).concat(
    candidateList.map((candidate, index) => {
      return [
        !candidate.isActive
          ? chalk.yellow(candidate.id.toString())
          : candidate.isSelected
          ? candidate.id
          : chalk.red(candidate.id.toString()),
        !candidate.isActive
          ? chalk.yellow(candidate.name.toString() + ` [off]`)
          : candidate.isSelected
          ? candidate.name
          : chalk.red(candidate.name.toString()),
        candidate.totalDelegators > 400
          ? chalk.red(candidate.totalDelegators)
          : candidate.totalDelegators > 300
          ? chalk.yellow(candidate.totalDelegators)
          : candidate.totalDelegators,
        numberWithCommas(candidate.totalDelegations / 10n ** 18n),
        ...candidate.totalRevokable.map((r, i) => printColoredNumber(r, sumRevokable[i])),
        candidate.totalDelegations - candidate.pendingRevoke < minCollator.totalDelegations
          ? chalk.red(numberWithCommas(candidate.pendingRevoke / 10n ** 18n))
          : candidate.totalDelegations - candidate.pendingRevoke < minCollatorFifth.totalDelegations
          ? chalk.yellow(numberWithCommas(candidate.pendingRevoke / 10n ** 18n))
          : numberWithCommas(candidate.pendingRevoke / 10n ** 18n),
      ];
    }),
    [
      [
        `Next Round #${roundInfo.current.toNumber() + 1} - blocks: -${
          roundInfo.first.toNumber() + roundInfo.length.toNumber() - blockHeader.number.toNumber()
        } (-${
          nextRoundSeconds / 3600 >= 1 ? `${Math.floor(nextRoundSeconds / 3600)}h` : ""
        }${Math.floor((nextRoundSeconds % 3600) / 60)
          .toString()
          .padStart(2, "0")}m)`,
        "Total",
        candidateList.reduce((p, c) => p + c.totalDelegators, 0),
        numberWithCommas(candidateList.reduce((p, c) => p + c.totalDelegations, 0n) / 10n ** 18n),
        ...new Array(8)
          .fill(0)
          .map((_, day) =>
            numberWithCommas(
              candidateList.reduce((p, c) => p + c.totalRevokable[day], 0n) / 10n ** 18n
            )
          ),
        numberWithCommas(candidateList.reduce((p, c) => p + c.pendingRevoke, 0n) / 10n ** 18n),
      ],
    ]
  );

  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length ||
        lineIndex == tableData.length - 1 ||
        lineIndex == tableData.length - candidateOffCount - 1 ||
        lineIndex == totalSelected.toNumber() + 1,
      columns: [
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
      ],
    })
  );
  await api.disconnect();
};

main();
