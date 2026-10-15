// Node preload that answers DNS lookups for chosen hosts with a fixed address,
// for checking a freshly deployed custom domain while resolvers still cache
// the old "no such name" answer (TLS and the Host header stay real).
//
//   PIN_DNS=aisub.hu=104.21.37.249 node --no-warnings --import ./scripts/pin-dns.mjs \
//     scripts/check-deployment.ts https://aisub.hu
//
// The address comes from the authoritative name server:
//   dig +short aisub.hu A @bingo.ns.cloudflare.com
import dns from "node:dns";

const pins = new Map(
  (process.env.PIN_DNS ?? "")
    .split(",")
    .map((pair) => pair.trim().split("="))
    .filter(([host, address]) => host && address),
);

const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const address = pins.get(host);
  if (!address) return lookup.call(dns, host, options, callback);
  const family = address.includes(":") ? 6 : 4;
  process.nextTick(() =>
    options?.all ? callback(null, [{ address, family }]) : callback(null, address, family),
  );
};
