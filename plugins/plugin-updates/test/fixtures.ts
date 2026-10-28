import type { InstalledPluginLike, UpdateResultLike } from "../src/pending";

export const GENUI_INSTALLED = "d86c13657608fc30aca5771aa94d531c11d053cc";
export const GENUI_CANDIDATE = "f1fb0e872fb287da2ffb49363bbf81513825cc29";
export const BURN_INSTALLED = "a713743ef433a4a6f0019ceb77ff8eb2520ff512";
export const BURN_CANDIDATE = "eed869846b8e48933dd653a329649b73b1d284a1";

export const genui: InstalledPluginLike = {
  id: "genui",
  name: "Generative UI",
  version: "0.2.6",
  icon: "AppWindow",
  iconUrl: null,
  logoUrl: null,
  updateState: { availableVersion: GENUI_CANDIDATE },
};

export const burn: InstalledPluginLike = {
  id: "burn",
  name: "Burn",
  version: "0.7.2",
  icon: "./assets/icon.svg",
  iconUrl: "/api/v1/plugins/burn/assets/icon?h=9f",
  logoUrl: null,
  updateState: { availableVersion: BURN_CANDIDATE },
};

export const current: InstalledPluginLike = {
  id: "loom",
  name: "Loom",
  version: "0.29.3",
  icon: "Loom",
  iconUrl: null,
  logoUrl: null,
  updateState: {},
};

export const results: UpdateResultLike[] = [
  {
    id: "genui",
    installed: { version: GENUI_INSTALLED, display: "https://github.com/o/r.git@genui/v0.2.6 (d86c13657608)" },
    candidate: { version: GENUI_CANDIDATE, display: "https://github.com/o/r.git@genui/v0.2.7 (f1fb0e872fb2)" },
  },
  {
    id: "burn",
    installed: { version: BURN_INSTALLED, display: "https://github.com/kalindudc/burn@HEAD (a713743ef433)" },
    candidate: { version: BURN_CANDIDATE, display: "https://github.com/kalindudc/burn@HEAD (eed869846b8e)" },
  },
];
