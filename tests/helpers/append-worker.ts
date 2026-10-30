/** Child process for the concurrent-append test: opens the shared ledger file and appends `count` events. */
import { Ledger } from "../../src/ledger/ledger";

const [path, count, tag] = process.argv.slice(2);
if (!path || !count || !tag) throw new Error("usage: append-worker <db> <count> <tag>");
const ledger = new Ledger(path);
for (let i = 0; i < Number(count); i++) ledger.append(null, "LOAD", { tag, i });
ledger.close();
