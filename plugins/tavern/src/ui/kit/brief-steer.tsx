import type { BriefSteer } from "../../shared/contract";
import { clockTime } from "./primitives";

export function BriefSteerLine({ name, steer }: { name: string; steer: BriefSteer }) {
  return <p className="m small brief-steer" data-content>{name}'s brief predates your steer of {clockTime(steer.at)}{steer.excerpt === null ? "." : `: “${steer.excerpt}”`}</p>;
}
