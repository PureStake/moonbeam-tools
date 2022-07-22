/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will find orphan requests (already executed but not removed
    from the delegator state)

Ex: ./node_modules/.bin/ts-node-transpile-only src/hotfixes/runtime-1700-migrate-stakoing-reserves-requests.ts \
   --network alphanet \
   --account-priv-key <key> \
*/
import "@moonbeam-network/api-augment/moonbase"
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";
import { ApiPromise, Keyring } from "@polkadot/api";
import { ApiDecoration } from "@polkadot/api/types";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: false, alias: "account" },
    "collators": { type: "boolean", demandOption: false, },
    "delegators": { type: "boolean", demandOption: false, },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const findUnmigratedCollators = async (apiAt: ApiDecoration<"promise">) => {
  const collatorState = await apiAt.query.parachainStaking.candidateInfo.entries();

  console.log(`examining ${collatorState.length}`);

  const collatorsToFix = [];
  for (const state of collatorState) {
    const storageKey = ""+state[0];
    const id = "0x"+ storageKey.substring(storageKey.length - 40, storageKey.length);

    let hasMigrated = 
      await apiAt.query.parachainStaking.collatorReserveToLockMigrations(id);

    console.log(`${id}: ${hasMigrated.eq(true) ? '✅' : '✗'}`);

    if (hasMigrated.eq(false)) {
      collatorsToFix.push(id);
    }
  }

  // Unify multiple occurences of the same collator.
  const collators = [...new Set(collatorsToFix)].sort();
  console.log(`Found ${collators.length} collators`);

  return collators;
}

const findUnmigratedDelegators = async (apiAt: ApiDecoration<"promise">) => {

  const delegatorsToFix = [];
  for await (const { args: [id] } of await apiAt.query.parachainStaking.delegatorState.keys()) {
    let hasMigrated = 
      await apiAt.query.parachainStaking.delegatorReserveToLockMigrations(id);

    console.log(`${id}: ${hasMigrated.eq(true) ? '✅' : '✗'}`);

    if (hasMigrated.eq(false)) {
      delegatorsToFix.push(id);
    }
  }

  // Unify multiple occurences of the same delegator.
  const delegators = [...new Set(delegatorsToFix)].sort();
  console.log(`Found ${delegators.length} delegators`);

  return delegators;
}

const main = async () => {
  const doDelegators = argv["delegators"] ? true : false;
  const doCollators = argv["collators"] ? true : false;

  if (! doDelegators && ! doCollators) {
    console.log("Error: must use one or both of --delegators and --collators");
    return 1;
  }

  // Instantiate Api
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const atBlockNumber = argv.at || (await api.rpc.chain.getHeader()).number.toNumber();
  const apiAt = await api.at(await api.rpc.chain.getBlockHash(atBlockNumber));

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  let collators = [];
  if (doCollators) {
    collators = await findUnmigratedCollators(apiAt);
  }
  let delegators = [];
  if (doDelegators) {
    delegators = await findUnmigratedDelegators(apiAt);
  }

  console.log(
    `Using data from block #${atBlockNumber} (${api.runtimeVersion.specName.toString()}-${runtimeVersion})`
  );

  const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
  const { nonce: rawNonce } = (await api.query.system.account(
    account.address
  ));
  let nonce = BigInt(rawNonce.toString());

    const BATCH_SIZE = 99;

    // send collator hotfix extrinsics
    if (doCollators) {
      for (let i = 0; i < collators.length; i += BATCH_SIZE) {
        const collatorChunk = collators.slice(i, i + BATCH_SIZE);
        console.log(`Preparing hotfix for ${collatorChunk.length} collators`);
        await api.tx.parachainStaking.hotfixMigrateCollatorsFromReserveToLocks(collatorChunk).signAndSend(account, { nonce: nonce++ });
      }
    }

    // send delegator hotfix extrinsics
    if (doDelegators) {
      for (let i = 0; i < delegators.length; i += BATCH_SIZE) {
        const delegatorChunk = delegators.slice(i, i + BATCH_SIZE);
        console.log(`Preparing hotfix for ${delegatorChunk.length} delegators`);
        await api.tx.parachainStaking.hotfixMigrateDelegatorsFromReserveToLocks(delegatorChunk).signAndSend(account, { nonce: nonce++ });
      }
  }

  await api.disconnect();
};

main();
