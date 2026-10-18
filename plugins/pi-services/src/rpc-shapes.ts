/** Shapes shared by the server's zod contract and the frontend's type-level contract. Keep in sync. */
export interface RegenerateTitleInput {
  threadId: string;
}
export interface RegenerateTitleOutput {
  title: string;
}
export interface UpdateSettingsInput {
  executable?: string | null;
  model?: string | null;
}
export interface UpdateSettingsOutput {
  executable: string;
  model: string;
}
