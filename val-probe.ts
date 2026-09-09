import { loadEnv } from "./lib/env"; loadEnv();
import { validateConfig, hasBlockingErrors } from "./app/lib/validate";
import { getAgentConfig } from "./app/lib/config";
(async()=>{
  const cfg = await getAgentConfig("default-agent");
  const f = validateConfig(cfg as any, null);
  console.log(`\n  blocked: ${hasBlockingErrors(f)}`);
  console.log(`  findings: ${f.length}`);
  for(const x of f as any[]) console.log(`    [${x.severity}] ${x.id}: ${x.message?.slice(0,80)}`);
  console.log();
})();
