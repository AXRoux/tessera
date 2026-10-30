/**
 * Lets the offline demo start over without restarting the process.
 *
 * Offline, the ledger and the simulated Airwallex both live in memory, so "reset" means building a second, empty pair and
 * routing new requests to it. The operator token is chosen once by the caller and reused, so the console keeps working
 * through a reset. A run still streaming on the old instance finishes against the old, discarded ledger.
 *
 * Live (sandbox) runs never get a reset: their ledger is the record of real sandbox transfers.
 */
export interface Instance {
  handle: (request: Request) => Promise<Response>;
  /** Called on every background sweep, against whichever instance is current. */
  sweep: () => Promise<void>;
}

export interface Resettable {
  handle: (request: Request) => Promise<Response>;
  sweep: () => Promise<void>;
  reset: () => Promise<void>;
  /** Milliseconds since the last request or reset; the demo resets itself when it has sat idle. */
  idleMs: () => number;
}

export async function resettable(build: () => Promise<Instance>): Promise<Resettable> {
  let current = await build();
  let lastUsed = Date.now();
  return {
    handle: (request) => {
      lastUsed = Date.now();
      return current.handle(request);
    },
    sweep: () => current.sweep(),
    reset: async () => {
      current = await build();
      lastUsed = Date.now();
    },
    idleMs: () => Date.now() - lastUsed,
  };
}
