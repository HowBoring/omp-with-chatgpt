import { getStateDir } from "../config/paths.js";
import { VERSION } from "../version.js";

interface MinimalExtensionApi {
  setLabel(label: string): void;
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: { ui: { notify(message: string, level?: string): void }; cwd: string }) => Promise<void> | void;
  }): void;
}

export default function ompWithChatGPT(pi: MinimalExtensionApi): void {
  pi.setLabel("OMP with ChatGPT");

  pi.registerCommand("c2c-status", {
    description: "Show the C2C migration scaffold status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `OMP with ChatGPT scaffold ${VERSION}; workspace=${ctx.cwd}; stateDir=${getStateDir()}`,
        "info"
      );
    },
  });
}
