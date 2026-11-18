import { experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { backupContract } from "../../shared/backup";
import type { BackupService } from "./service";

export function backupHandlers(service: BackupService): ExperimentalPluginRpcHandlersWithContext<typeof backupContract> {
  return {
    backupList: () => service.list(),
    backupSave: async input => {
      const result = await service.save(input);
      return { code: result.code, backup: result.backup, pruned: result.pruned, problem: result.problem };
    },
    backupExport: input => service.export(input),
    backupRestore: (input, context) => {
      if (context?.experimental_caller.kind !== "client") throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Backup restores require an explicit client action; plugins cannot restore your settings, definitions or records." });
      return service.restore(input);
    },
    registryFile: input => service.registryFile(input.kind, input.id),
    registryExportFolder: input => service.registryExportFolder(input.kind, input.ids),
  };
}
export function registerBackupRpc(bb: BbPluginApi, service: BackupService) { bb.rpc.register(backupContract, backupHandlers(service)); }
