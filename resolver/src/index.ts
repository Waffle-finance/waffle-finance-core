#!/usr/bin/env node
import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { configSummaryCommand } from "./commands/config-summary.js;
import { registerCommand, statusCommand, unregisterCommand } from "./commands/register.js";

const program = new Command();

program
  .name("wafflefinance-resolver")
  .description("Reference resolver runner for the WaffleFinance cross-chain bridge")
  .version("0.1.0");

program
  .command("run")
  .description("Start the resolver. Listens to both chains and reacts to HTLC events.")
  .action(async () => {
    await runCommand();
  });

program
  .command("config-summary")
  .description("Validate runtime configuration and print a redacted per-chain summary without starting listeners.")
  .action(async () => {
    await configSummaryCommand();
  });

program
  .command("register")
  .description("Stake into the ResolverRegistry so this resolver is eligible to fill orders.")
  .argument("[amount]", "Stake amount in the registry's stake asset (default: minStake)")
  .action(async (amount?: string) => {
    await registerCommand(amount);
  });

program
  .command("status")
  .description("Print the current registration status of this resolver.")
  .action(async () => {
    await statusCommand();
  });

program
  .command("unregister")
  .description("Withdraw stake and unregister this resolver.")
  .action(async () => {
    await unregisterCommand();
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
