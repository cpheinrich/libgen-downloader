import { cli } from "./cli";
import { operate } from "./cli/operate";

try {
  await operate(cli.flags);
} catch (error) {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

export { version as APP_VERSION } from "../package.json";
