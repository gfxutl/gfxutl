export function normalizeS3Endpoint(value: string) {
  const raw = value.trim();
  if (!raw) throw new Error("エンドポイントURLを入力してください");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("S3エンドポイントはHTTPまたはHTTPS URLで指定してください");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function normalizeS3Prefix(value: string) {
  const prefix = value.trim().replace(/^\/+/, "");
  return prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
}

export function s3ObjectUrl(endpoint: URL, bucket: string, key: string, pathStyle: boolean) {
  const url = new URL(endpoint);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (pathStyle) {
    const base = url.pathname.replace(/\/$/, "");
    url.pathname = `${base}/${encodeURIComponent(bucket)}${encodedKey ? `/${encodedKey}` : "/"}`;
  } else {
    url.hostname = `${bucket}.${url.hostname}`;
    const base = url.pathname.replace(/\/$/, "");
    url.pathname = `${base}${encodedKey ? `/${encodedKey}` : "/"}`;
  }
  return url;
}
