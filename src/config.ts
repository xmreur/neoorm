export type NeoOrmConfig = {
  schema: string;
  out: string;
  datasource: {
    provider: "postgresql";
    url: string;
    schema?: string;
    enum?: "check" | "union" | "native";
  };
};

export function defineConfig(config: NeoOrmConfig): NeoOrmConfig {
  return config;
}

export async function loadConfig(cwd: string): Promise<NeoOrmConfig> {
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { register } = await import("tsx/esm/api");

  register();

  const configPath = join(cwd, "neoorm.config.ts");
  const mod = await import(pathToFileURL(configPath).href);
  const config = mod.default ?? mod.config;

  if (!config?.schema || !config?.out || !config?.datasource?.url) {
    throw new Error(
      "neoorm.config.ts must export defineConfig({ schema, out, datasource: { provider, url } })",
    );
  }

  return config as NeoOrmConfig;
}
