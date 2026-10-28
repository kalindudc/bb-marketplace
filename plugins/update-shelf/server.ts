import { createGitHub, firstAvailable, ghTransport, publicTransport } from "./src/github";
import { createPlugin } from "./src/plugin";

export default createPlugin({ github: createGitHub(firstAvailable(ghTransport(), publicTransport())) });
