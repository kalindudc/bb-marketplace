import { useState } from "react";
import { toast } from "sonner";
import type { Config } from "../../config";
import { messageOf, useShuttleMutation, useShuttleQuery } from "../data";

/** Shuttle's whole config, and a save that sends all of it; a refusal keeps the server's message for the section to show. */
export function useConfig() {
  const query = useShuttleQuery("getConfig", {});
  // The form shows what it sent until the server's parsed config arrives in its place.
  const saveConfig = useShuttleMutation("saveConfig", ({ config }, cache) => cache.update("getConfig", {}, () => ({ config: config as Config })));
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async (next: Config, done = "Saved"): Promise<boolean> => {
    setSaveError(null);
    try {
      await saveConfig.mutate({ config: next });
      toast.success(done);
      return true;
    } catch (error) {
      const message = messageOf(error);
      setSaveError(message);
      toast.error(message);
      return false;
    }
  };
  return {
    config: query.data?.config ?? null,
    loadError: query.error === null ? null : messageOf(query.error),
    saving: saveConfig.isPending,
    saveError,
    save,
    clearSaveError: () => setSaveError(null),
  };
}
