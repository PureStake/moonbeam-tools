import { ApiPromise, WsProvider } from "@polkadot/api";
import yargs from "yargs";
import fs from "fs";

export const NETWORK_WS_URLS: { [name: string]: string } = {
  rococo: "wss://rococo-rpc.polkadot.io",
  westend: "wss://westend.api.onfinality.io/public-ws",
  kusama: "wss://kusama.api.onfinality.io/public-ws",
  polkadot: "wss://polkadot.api.onfinality.io/public-ws",
};

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    at: {
      type: "number",
      description: "Block number",
    },
    output: {
      alias: "o",
      type: "number",
      demandOption: true,
      description: "Output file",
    },
    network: {
      type: "string",
      choices: Object.keys(NETWORK_WS_URLS),
      string: true,
      description: "",
    },
  }).argv;

const main = async () => {
  const api = await ApiPromise.create({
    provider: new WsProvider(NETWORK_WS_URLS[argv.network]),
  });

  const blockHash = (await api.rpc.chain.getBlockHash(argv.at)).toString();

  const code = (await api.rpc.state.getStorage(":code", blockHash)) as any;
  fs.writeFileSync("runtime.wasm", Buffer.from(code.unwrap()));

  await api.disconnect();
};

main();
