import { AwsClient } from "aws4fetch";
import { normalizeS3Endpoint, normalizeS3Prefix, s3ObjectUrl } from "./s3-address";

export interface S3ConnectionSettings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle: boolean;
}

export interface S3ListedObject {
  key: string;
  size: number;
  lastModified: number;
}

export interface S3DirectoryListing {
  prefixes: string[];
  objects: S3ListedObject[];
}

export class S3MediaSource {
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly pathStyle: boolean;
  private readonly client: AwsClient;
  private readonly files = new Map<string, Promise<File>>();

  constructor(settings: S3ConnectionSettings) {
    this.endpoint = normalizeS3Endpoint(settings.endpoint);
    this.region = settings.region.trim();
    this.bucket = settings.bucket.trim();
    this.prefix = normalizeS3Prefix(settings.prefix);
    this.pathStyle = settings.pathStyle;
    if (!this.region) throw new Error("リージョンを入力してください");
    if (!this.bucket) throw new Error("バケット名を入力してください");
    if (!settings.accessKeyId.trim() || !settings.secretAccessKey) throw new Error("Access Key IDとSecret Access Keyを入力してください");
    this.client = new AwsClient({
      accessKeyId: settings.accessKeyId.trim(),
      secretAccessKey: settings.secretAccessKey,
      sessionToken: settings.sessionToken?.trim() || undefined,
      service: "s3",
      region: this.region,
      retries: 2,
    });
  }

  async list(prefix = this.prefix): Promise<S3DirectoryListing> {
    const normalizedPrefix = normalizeS3Prefix(prefix);
    const prefixes: string[] = [];
    const objects: S3ListedObject[] = [];
    let continuationToken = "";
    const seenTokens = new Set<string>();
    do {
      const url = this.objectUrl("");
      url.searchParams.set("list-type", "2");
      url.searchParams.set("delimiter", "/");
      if (normalizedPrefix) url.searchParams.set("prefix", normalizedPrefix);
      if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
      const document = await this.requestXml(url);
      for (const element of document.getElementsByTagName("CommonPrefixes")) {
        const value = xmlText(element, "Prefix");
        if (value && !prefixes.includes(value)) prefixes.push(value);
      }
      for (const element of document.getElementsByTagName("Contents")) {
        const key = xmlText(element, "Key");
        if (!key || key === normalizedPrefix) continue;
        objects.push({
          key,
          size: Number(xmlText(element, "Size")) || 0,
          lastModified: Date.parse(xmlText(element, "LastModified")) || 0,
        });
      }
      const nextToken = xmlText(document, "NextContinuationToken");
      if (nextToken && seenTokens.has(nextToken)) throw new Error("S3の一覧取得で同じ継続トークンが繰り返されました");
      if (nextToken) seenTokens.add(nextToken);
      continuationToken = nextToken;
    } while (continuationToken);
    return { prefixes, objects };
  }

  getFile(key: string, lastModified = 0) {
    const cached = this.files.get(key);
    if (cached) return cached;
    const request = this.download(key, lastModified).catch((error) => {
      this.files.delete(key);
      throw error;
    });
    this.files.set(key, request);
    return request;
  }

  sourcePath(key: string) {
    const endpointKey = `${this.endpoint.host}${this.endpoint.pathname === "/" ? "" : this.endpoint.pathname.replace(/\/$/, "")}`;
    return `s3://${endpointKey}/${this.bucket}/${key}`;
  }

  private async download(key: string, lastModified: number) {
    const response = await this.request(this.objectUrl(key));
    const blob = await response.blob();
    return new File([blob], s3BaseName(key), {
      type: response.headers.get("content-type") || blob.type || "application/octet-stream",
      lastModified: lastModified || Date.now(),
    });
  }

  private objectUrl(key: string) {
    return s3ObjectUrl(this.endpoint, this.bucket, key, this.pathStyle);
  }

  private async requestXml(url: URL) {
    const response = await this.request(url);
    const document = new DOMParser().parseFromString(await response.text(), "application/xml");
    if (document.querySelector("parsererror")) throw new Error("S3から不正なXMLレスポンスを受信しました");
    return document;
  }

  private async request(url: URL) {
    let response: Response;
    try {
      response = await this.client.fetch(url, { method: "GET", credentials: "omit" });
    } catch (cause) {
      throw new Error("S3エンドポイントへ接続できません。URL、CORS、ネットワーク設定を確認してください", { cause });
    }
    if (response.ok) return response;
    const body = await response.text().catch(() => "");
    const message = s3ErrorMessage(body);
    throw new Error(`S3 ${response.status} ${response.statusText}${message ? `: ${message}` : ""}`);
  }
}

function xmlText(parent: ParentNode, tagName: string) {
  return parent.querySelector(tagName)?.textContent?.trim() ?? "";
}

function s3ErrorMessage(xml: string) {
  if (!xml) return "";
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const code = xmlText(document, "Code");
  const message = xmlText(document, "Message");
  return [code, message].filter(Boolean).join(" — ").slice(0, 500);
}

function s3BaseName(key: string) {
  return key.split("/").filter(Boolean).at(-1) || "object";
}
