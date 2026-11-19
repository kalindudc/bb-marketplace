import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { KeeperStore } from "../keeper/store";
import { userActHandlers, requireUserAct, type UserActReceipt } from "../authority";
import { backupContract } from "../../shared/backup";
import type { BackupService } from "./service";

export function backupHandlers(service: BackupService): ExperimentalPluginRpcHandlersWithContext<typeof backupContract> {
  return userActHandlers({
    backupList: () => service.list(),
    backupSave: async input => {
      const result = await service.save(input);
      return { code: result.code, backup: result.backup, pruned: result.pruned, problem: result.problem };
    },
    backupExport: input => service.export(input),
    backupRestore: (input, context: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => { requireUserAct(context, "backupRestore"); return service.restore(input, receipt); },
    registryFile: input => service.registryFile(input.kind, input.id),
    registryExportFolder: input => service.registryExportFolder(input.kind, input.ids),
  }, new KeeperStore(service.options.settings.db), () => service.options.settings.now());
}
export function registerBackupRpc(bb: BbPluginApi, service: BackupService) { bb.rpc.register(backupContract, backupHandlers(service)); }
