import type { Member } from "./schema";

export function memberPlace(state: Member["state"]): Member["place"] {
  return state === "working" ? "road" : state === "done" || state === "stopped" ? "rest" : "table";
}
