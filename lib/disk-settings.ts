import path from "node:path";

export type DiskSettings={root:string;database:string;media:string;temporary:string};

/** Default to portable app-owned data; relative overrides resolve from the application directory. */
export function readDiskSettings(env:NodeJS.ProcessEnv=process.env,appDirectory=process.cwd()):DiskSettings {
  if((env.IDEA_BANK_AUTH_MODE?.trim() || "local")!=="local" || env.VERCEL)throw new Error("Дисковое хранилище доступно только при локальном запуске.");
  const explicit=env.IDEA_BANK_DATA_DIR?.trim();
  const root=path.resolve(appDirectory,explicit || "data");
  return {root,database:path.join(root,"library.sqlite"),media:path.join(root,"media"),temporary:path.join(root,"temporary")};
}
