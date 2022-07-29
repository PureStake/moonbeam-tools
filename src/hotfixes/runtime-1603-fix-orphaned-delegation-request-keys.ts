/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will find candidates that have already left the network
  but still have a empty entry in `DelegationScheduledRequests` storage,
  and remove these entries.

Ex: ./node_modules/.bin/ts-node-transpile-only src/hotfixes/runtime-1603-fix-orphaned-delegation-request-keys.ts \
   --network alphanet \
   --send-preimage-hash \
   --send-proposal-as council-external \
   --collective-threshold 3 \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { ApiPromise, Keyring } from "@polkadot/api";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": {
      type: "string",
      demandOption: false,
      alias: "account",
    },
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  const blockHash = await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  const keyring = new Keyring({ type: "ethereum" });
  const signer = keyring.addFromUri(argv["account-priv-key"], null, "ethereum");

  try {
    const scheduledRequestAccounts = new Set(
      (await apiAt.query.parachainStaking.delegationScheduledRequests.keys()).map(
        ({ args: [accountId] }) => accountId.toString()
      )
    );
    const collators = new Set(
      (await apiAt.query.parachainStaking.candidateInfo.keys()).map(({ args: [accountId] }) =>
        accountId.toString()
      )
    );

    // verify empty delegation requests
    const accountsToFix = [...scheduledRequestAccounts].filter(
      (accountId) => !collators.has(accountId)
    );
    for (const account of accountsToFix) {
      const requests = await apiAt.query.parachainStaking.delegationScheduledRequests(account);
      if (!requests.isEmpty) {
        throw new Error(`delegationScheduledRequests was not empty for collator "${account}"`);
      }
    }

    const chunkSize = 10;
    console.log(`hotfixing ${accountsToFix.length} accounts in chunks of ${chunkSize}`);
    for (let i = 0; i < accountsToFix.length; i += chunkSize) {
      const chunk = accountsToFix.slice(i, i + chunkSize);
      const tx = await api.tx.parachainStaking
        .hotfixRemoveDelegationRequestsExitedCandidates(chunk)
        .signAsync(signer);

      console.log(`batch ${(i % (chunkSize-1)) + 1}: ${chunk.join(", ")}`);
      await waitTxDone(api, tx);
    }
  } finally {
    await api.disconnect();
  }
}

async function waitTxDone(
  api: ApiPromise,
  tx: SubmittableExtrinsic,
  timeoutMs = 120000
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let unsub = () => {};

    const timer = setTimeout(() => {
      reject("timed out");
      unsub();
    }, timeoutMs);

    const resolveUnsub = (value: any) => {
      clearTimeout(timer);
      unsub();
      resolve(value);
    };
    const rejectUnsub = (value: any) => {
      clearTimeout(timer);
      unsub();
      reject(value);
    };

    unsub = await tx.send(({ status, dispatchError, internalError }) => {
      if (internalError) {
        return rejectUnsub(internalError);
      }

      if (status.isInBlock || status.isFinalized) {
        if (dispatchError) {
          return rejectUnsub({
            inBlock: status.asInBlock.toString(),
            error: api.registry.findMetaError(dispatchError.asModule),
          });
        }

        resolveUnsub(status.asInBlock.toString());
      }
    });
  });
}

main().catch((err) => console.error("ERR!", err));
