// This script is expected to run against a parachain network (using launch.ts script)
//
// Purpose is to find the accounts that have unreserved balances leftover from a staking
// bug.
import yargs from "yargs";
import "@moonbeam-network/api-augment";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";
import { Keyring } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: false, alias: "account" },
    "send-preimage-hash": { type: "boolean", demandOption: false, alias: "h" },
    "send-proposal-as": {
      choices: ["democracy", "council-external", "sudo"],
      demandOption: false,
      alias: "s",
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
  })
  .check(function (argv) {
    if (argv["send-preimage-hash"] && !argv["account-priv-key"]) {
      console.log(`Missing --account-priv-key`);
      return false;
    }
    return true;
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  // Ensure all the state queries happen on the same block number, for consistency
  const apiAt = await api.at(
    argv.at ? await api.rpc.chain.getBlockHash(argv.at) : await api.rpc.chain.getBlockHash()
  );

  const keyring = new Keyring({ type: "ethereum" });
  // Load data
  const [
    proxies,
    proxyAnnouncements,
    treasuryProposals,
    mappingWithDeposit,
    candidateInfo,
    delegatorState,
    identities,
    preimages,
    assets,
    assetsMetadata,
  ] = await Promise.all([
    apiAt.query.proxy.proxies.entries(),
    apiAt.query.proxy.announcements.entries(),
    apiAt.query.treasury.proposals.entries(),
    apiAt.query.authorMapping.mappingWithDeposit.entries(),
    apiAt.query.parachainStaking.candidateInfo.entries(),
    apiAt.query.parachainStaking.delegatorState.entries(),
    apiAt.query.identity.identityOf.entries(),
    apiAt.query.democracy.preimages.entries(),
    apiAt.query.assets.asset.entries(),
    apiAt.query.assets.metadata.entries(),
  ]);

  const expectedReserveByAccount: { [accountId: string]: bigint } = [
    treasuryProposals.map((proposal) => ({
      accountId: `0x${proposal[1].unwrap().proposer.toHex().slice(-40)}`,
      reserved: proposal[1].unwrap().bond.toBigInt(),
    })),
    proxies.map((proxy) => ({
      accountId: `0x${proxy[0].toHex().slice(-40)}`,
      reserved: proxy[1][1].toBigInt(),
    })),
    proxyAnnouncements.map((announcement) => ({
      accountId: `0x${announcement[0].toHex().slice(-40)}`,
      reserved: announcement[1][1].toBigInt(),
    })),
    mappingWithDeposit.map((mapping) => ({
      accountId: `0x${mapping[1].unwrap().account.toHex().slice(-40)}`,
      reserved: mapping[1].unwrap().deposit.toBigInt(),
    })),
    candidateInfo.map((candidate) => ({
      accountId: `0x${candidate[0].toHex().slice(-40)}`,
      reserved: candidate[1].unwrap().bond.toBigInt(),
    })),
    delegatorState.map((delegator) => ({
      accountId: `0x${delegator[0].toHex().slice(-40)}`,
      reserved: delegator[1].unwrap().total.toBigInt(),
    })),
    identities.map((identity) => ({
      accountId: `0x${identity[0].toHex().slice(-40)}`,
      reserved: identity[1].unwrap().deposit.toBigInt(),
    })),
    preimages
      .filter((preimage) => preimage[1].unwrap().isAvailable)
      .map((preimage) => ({
        accountId: `0x${preimage[1].unwrap().asAvailable.provider.toHex().slice(-40)}`,
        reserved: preimage[1].unwrap().asAvailable.deposit.toBigInt(),
      })),
    assets.map((asset) => ({
      accountId: `0x${asset[1].unwrap().owner.toHex().slice(-40)}`,
      reserved: asset[1].unwrap().deposit.toBigInt(),
    })),
    assetsMetadata.map((metadata) => ({
      accountId: `0x${assets
        .find((asset) => asset[0].toHex().slice(-64) == metadata[0].toHex().slice(-64))[1]
        .unwrap()
        .owner.toHex()
        .slice(-40)}`,
      reserved: metadata[1].deposit.toBigInt(),
    })),
  ]
    .flat()
    .reduce((p, v) => {
      p[v.accountId] = (p[v.accountId] || 0n) + v.reserved;
      return p;
    }, {});

  const accountsToAddReserve: { accountId: string; reserve: bigint }[] = [];
  const accountsToRemoveReserve: { accountId: string; reserve: bigint }[] = [];
  const limit = 1000;
  let last_key = "";
  let count = 0;
  
  // loop over all system accounts
  while (true) {
    let query = await api.query.system.account.entriesPaged({
      args: [],
      pageSize: limit,
      startKey: last_key,
    });

    if (query.length == 0) {
      break;
    }
    count += query.length;

    for (const user of query) {
      let accountId = `0x${user[0].toHex().slice(-40)}`;
      let reserved = user[1].data.reserved.toBigInt();
      last_key = user[0].toString();

      const expectedReserve = expectedReserveByAccount[accountId] || 0n;

      if (expectedReserve != reserved) {
        console.log(
          `${accountId}: reserved ${reserved.toString().padStart(25)} vs expected ${expectedReserve
            .toString()
            .padStart(25)} (diff: ${(reserved - expectedReserve).toString().padStart(25)})`
        );
        if (reserved < expectedReserve) {
          accountsToAddReserve.push({
            accountId,
            reserve: expectedReserve - reserved,
          });
        } else {
          accountsToRemoveReserve.push({
            accountId,
            reserve: reserved - expectedReserve,
          });
        }
      }
    }
    console.log(`...${count}`);
  }

  console.log(
    `Total reserve
      - missing: ${accountsToAddReserve
        .reduce((p, v) => p + v.reserve, 0n)
        .toString()
        .padStart(25)} - ${accountsToAddReserve.length} accounts
      -   extra: ${accountsToRemoveReserve
        .reduce((p, v) => p + v.reserve, 0n)
        .toString()
        .padStart(25)} - ${accountsToRemoveReserve.length} accounts`
  );

  // EXPECTED RESERVED = STAKING (CANDIDATE || DELEGATOR) + AUTHOR MAPPING +
  // PROXY + TREASURY

  if (argv["send-preimage-hash"]) {
    const collectiveThreshold = argv["collective-threshold"] || 1;
    const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address
    )) as any;
    let nonce = BigInt(rawNonce.toString());
    const BATCH_SIZE = 500;
    for (let i = 0; i < accountsToRemoveReserve.length; i += BATCH_SIZE) {
      const fixChunk = accountsToRemoveReserve.slice(i, i + BATCH_SIZE);
      console.log(`Preparing force unreserve for ${fixChunk.length} accounts`);
      const forceUnreserveCalls = [];
      fixChunk.forEach(({ accountId, reserve }) => {
        forceUnreserveCalls.push(api.tx.balances.forceUnreserve(accountId, reserve));
      });
      const batchCall = api.tx.utility.batchAll(forceUnreserveCalls);
      let encodedProposal = batchCall?.method.toHex() || "";
      let encodedHash = blake2AsHex(encodedProposal);
      console.log("Encoded proposal hash for complete is %s", encodedHash);
      console.log("Encoded length %d", encodedProposal.length);

      console.log("Sending pre-image");
      await api.tx.democracy.notePreimage(encodedProposal).signAndSend(account, { nonce: nonce++ });

      if (argv["send-proposal-as"] == "democracy") {
        console.log("Sending proposal");
        await api.tx.democracy
          .propose(encodedHash, await api.consts.democracy.minimumDeposit)
          .signAndSend(account, { nonce: nonce++ });
      } else if (argv["send-proposal-as"] == "council-external") {
        console.log("Sending external motion");
        let external = api.tx.democracy.externalProposeMajority(encodedHash);
        await api.tx.councilCollective
          .propose(collectiveThreshold, external, external.length)
          .signAndSend(account, { nonce: nonce++ });
      }
    }
  }
  api.disconnect();
};

main();
