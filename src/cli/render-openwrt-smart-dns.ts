import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadOpenWrtSmartDnsPolicy, renderOpenWrtAddressRules } from "../openwrt-smart-dns.js";

function outputPath(argv: string[]): string | null {
  if (!argv.length) return null;
  if (argv.length === 2 && argv[0] === "--output" && argv[1]) return argv[1];
  if (argv.length === 1 && argv[0].startsWith("--output=")) return argv[0].slice("--output=".length);
  throw new Error("usage: render-openwrt-smart-dns [--output PATH]");
}

async function main(): Promise<void> {
  const output = outputPath(process.argv.slice(2));
  const rendered = renderOpenWrtAddressRules(await loadOpenWrtSmartDnsPolicy());
  if (!output) {
    process.stdout.write(rendered);
    return;
  }
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, rendered, "utf8");
  await rename(temporary, output);
  console.log(`Rendered ${rendered.trim().split("\n").length} OpenWrt SmartDNS rules to ${output}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
