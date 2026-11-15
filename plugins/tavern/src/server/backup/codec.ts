import { backupBundleSchema, type BackupBundle, type BackupManifest } from "../../shared/backup";
import { fileHash } from "../settings/files";
import { LIMITS } from "../limits";

export type BackupFile = Omit<BackupManifest["files"][number], "sha256" | "bytes"> & { text: string };
export const backupName = (at: number) => { const iso = new Date(at).toISOString(); return `${iso.slice(0, 10)}-${iso.slice(11, 16).replace(":", "")}`; };
export const managedBackupName = (name: string) => /^\d{4}-\d{2}-\d{2}-\d{4}(?:-[1-9]\d*)?$/.test(name);
export function safePayloadPath(path: string) {
  return !/[\\\0]/.test(path) && !path.startsWith("/") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function validLocation(file: BackupManifest["files"][number], manifest: BackupManifest) {
  const { kind, projectId, effective, source, path, id } = file;
  if (!safePayloadPath(path)) return false;
  if (["settings", "records", "scopes"].includes(kind)) return !effective && source === "global" && projectId === null && id === null && path === ({ settings: "settings.toml", records: "records.json", scopes: "scopes.yml" } as Record<string, string>)[kind];
  if (projectId !== null && !manifest.projects.some(project => project.id === projectId)) return false;
  if (source === "project" && projectId === null || !effective && source === "shipped") return false;
  const directory = kind === "class" ? "classes" : "characters";
  const prefix = `${effective ? "effective/" : ""}${projectId === null ? "" : `projects/${encodeURIComponent(projectId)}/`}${directory}/`;
  const filename = path.slice(prefix.length);
  return path.startsWith(prefix) && !filename.includes("/") && filename.endsWith(".md") && (!effective || id !== null && filename === `${id}.md`);
}
export function validateBundle(input: unknown): BackupBundle {
  if (typeof input === "string" && Buffer.byteLength(input) > LIMITS.backupBundleBytes) throw new Error("Backup bundle exceeds its safety limit");
  const bundle = backupBundleSchema.parse(typeof input === "string" ? JSON.parse(input) : input);
  const manifest = bundle.manifest, names = new Set<string>();
  if (manifest.schemaVersion !== manifest.migrations.length) throw new Error("Backup migration count does not match its schema version");
  if (new Set(manifest.projects.map(project => project.id)).size !== manifest.projects.length) throw new Error("Backup has duplicate projects");
  if (manifest.files.length > LIMITS.backupFiles) throw new Error("Backup has too many files");
  let bytes = Buffer.byteLength(JSON.stringify(manifest));
  for (const file of manifest.files) {
    if (names.has(file.path) || !validLocation(file, manifest)) throw new Error(`Invalid or duplicate backup path: ${file.path}`);
    names.add(file.path);
    const part = file.kind === "class" ? "classes" : file.kind === "character" ? "characters" : file.kind;
    if (part !== "records" && !manifest.parts.includes(part)) throw new Error(`Backup file is outside the declared parts: ${file.path}`);
    if (!Object.hasOwn(bundle.files, file.path)) throw new Error(`Backup file is missing: ${file.path}`);
    const text = bundle.files[file.path]!;
    if (Buffer.byteLength(text) !== file.bytes || fileHash(text) !== file.sha256) throw new Error(`Backup file failed its size or SHA-256 check: ${file.path}`);
    if (file.bytes > (file.kind === "records" ? LIMITS.backupBundleBytes : LIMITS.backupFileBytes)) throw new Error(`Backup file is too large: ${file.path}`);
    bytes += file.bytes;
  }
  if (Object.keys(bundle.files).some(path => !names.has(path))) throw new Error("Backup contains an unlisted file");
  if (bytes > LIMITS.backupBundleBytes) throw new Error("Backup bundle exceeds its safety limit");
  const records = manifest.files.filter(file => file.kind === "records");
  if (records.length > 1 || manifest.data.included !== (records.length === 1) || manifest.data.bytes !== (records[0]?.bytes ?? 0) || (manifest.counts.records === null) === manifest.data.included) throw new Error("Backup data declaration does not match its records file");
  const classes = new Set(manifest.files.filter(file => file.kind === "class" && file.id !== null).map(file => file.id));
  const characters = new Set(manifest.files.filter(file => file.kind === "character" && file.id !== null).map(file => file.id));
  if (classes.size !== manifest.counts.classes || characters.size !== manifest.counts.characters) throw new Error("Backup definition counts do not match its files");
  return bundle;
}
export function sealBundle(manifest: Omit<BackupManifest, "files" | "data">, files: BackupFile[]): BackupBundle {
  const records = files.find(file => file.kind === "records");
  return validateBundle({ manifest: { ...manifest, data: { included: records !== undefined, bytes: records ? Buffer.byteLength(records.text) : 0 }, files: files.map(({ text, ...file }) => ({ ...file, bytes: Buffer.byteLength(text), sha256: fileHash(text) })) }, files: Object.fromEntries(files.map(file => [file.path, file.text])) });
}
export const bundleHash = (bundle: BackupBundle) => fileHash(JSON.stringify(bundle.manifest));
