export type ForgeLinkConfig = {
  type: "github";
  repo: string;
  fileUrl: string;
  prUrl: string;
};

export function applyForgeTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (token, key: string) => {
    const value = values[key];
    if (value === undefined) return token;
    return value
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
  });
}

export function forgeFileUrl(forge: ForgeLinkConfig, ref: string, filePath: string): string {
  return applyForgeTemplate(forge.fileUrl, {
    repo: forge.repo,
    ref,
    path: filePath,
  });
}

export function forgeFolderUrl(forge: ForgeLinkConfig, ref: string, filePath: string): string {
  const folder = filePath.split("/").slice(0, -1).join("/");
  const template = forge.fileUrl.includes("/blob/")
    ? forge.fileUrl.replace("/blob/", "/tree/")
    : forge.fileUrl;
  return applyForgeTemplate(template, {
    repo: forge.repo,
    ref,
    path: folder,
  });
}

export function forgePrUrl(forge: ForgeLinkConfig, pr: number): string {
  return applyForgeTemplate(forge.prUrl, {
    repo: forge.repo,
    pr: String(pr),
  });
}
